'use strict';
/* Calendar reading + free-time planning. Pure functions: no DOM, no network.
   Loaded as a plain script in the browser (global FQSchedule) and with require() in tests. */
(function (root) {
  const MIN = 60e3, HOUR = 60 * MIN;

  // ---- read an .ics feed into events within [fromMs, toMs] ----
  // ICAL is the ical.js library, passed in so tests can load it differently from the browser.
  function expandEvents(ICAL, text, fromMs, toMs, cal) {
    const comp = new ICAL.Component(ICAL.parse(text));
    for (const tz of comp.getAllSubcomponents('vtimezone')) {
      try {
        const t = new ICAL.Timezone(tz);
        try { ICAL.TimezoneService.register(t); } catch (e) { ICAL.TimezoneService.register(t.tzid, t); }
      } catch (e) { /* unknown zone definition: events fall back to floating time */ }
    }
    const masters = new Map(), strays = [], out = [];
    const events = comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v));
    for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
    for (const e of events) {
      if (!e.isRecurrenceException()) continue;
      const m = masters.get(e.uid);
      if (m) m.relateException(e); else strays.push(e); // moved instance whose series we don't have
    }
    const push = (item, start, end) => {
      const status = String(item.component.getFirstPropertyValue('status') || '').toUpperCase();
      if (status === 'CANCELLED') return;
      const transp = String(item.component.getFirstPropertyValue('transp') || '').toUpperCase();
      const allDay = !!start.isDate;
      let s, e2;
      if (allDay) { s = new Date(start.year, start.month - 1, start.day).getTime(); e2 = new Date(end.year, end.month - 1, end.day).getTime(); }
      else { s = start.toJSDate().getTime(); e2 = end.toJSDate().getTime(); }
      if (!(e2 > s)) e2 = s + (allDay ? 24 * HOUR : 0);
      if (e2 <= fromMs || s >= toMs) return;
      out.push({ start: s, end: e2, allDay, title: item.summary || '', cal: cal || '', busy: transp !== 'TRANSPARENT' });
    };
    for (const e of [...masters.values(), ...strays]) {
      try {
        if (e.isRecurring()) {
          const it = e.iterator();
          let t, n = 0;
          while ((t = it.next()) && n++ < 20000) {
            if (t.toJSDate().getTime() > toMs) break;
            const d = e.getOccurrenceDetails(t);
            push(d.item, d.startDate, d.endDate);
          }
        } else push(e, e.startDate, e.endDate);
      } catch (err) { /* skip one broken event, keep the rest */ }
    }
    return out;
  }

  // ---- free gaps inside working hours ----
  // opts: {days, dayStart, dayEnd (minutes after midnight), buffer (minutes kept clear after each event), minGap}
  function freeSlots(events, now, opts) {
    const o = Object.assign({ days: 7, dayStart: 9 * 60, dayEnd: 21 * 60, buffer: 10, minGap: 10 }, opts);
    // weekly "never plan work then" rules -> blocks for every day in the horizon
    const blocks = [];
    const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
    for (let d = -1; d <= o.days; d++) {
      const day = new Date(day0); day.setDate(day.getDate() + d);
      for (const b of o.blocked || []) {
        if (!(b.days || []).includes(day.getDay())) continue;
        const bs = new Date(day); bs.setHours(0, b.start, 0, 0);
        const be = new Date(day); be.setHours(0, b.end, 0, 0);
        if (be > bs) blocks.push([bs.getTime(), be.getTime()]);
      }
    }
    const busy = events.filter(e => e.busy && !e.allDay).map(e => [e.start, e.end + o.buffer * MIN]).concat(blocks).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]); else merged.push([b[0], b[1]]);
    }
    const slots = [];
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const first = Math.ceil(now / (5 * MIN)) * 5 * MIN; // round up to the next 5 minutes
    for (let d = 0; d < o.days; d++) {
      const day = new Date(startOfToday); day.setDate(day.getDate() + d);
      const ws = new Date(day); ws.setHours(0, o.dayStart, 0, 0);
      const we = new Date(day); we.setHours(0, o.dayEnd, 0, 0);
      let cur = Math.max(ws.getTime(), first); const end = we.getTime();
      if (cur >= end) continue;
      for (const [bs, be] of merged) {
        if (be <= cur) continue;
        if (bs >= end) break;
        if (bs > cur && bs - cur >= o.minGap * MIN) slots.push([cur, bs]);
        cur = Math.max(cur, be);
        if (cur >= end) break;
      }
      if (cur < end && end - cur >= o.minGap * MIN) slots.push([cur, end]);
    }
    return slots;
  }

  // minutes a task is expected to take: its own estimate, else guess from ease
  function defaultMinutes(item) {
    if (item.minutes > 0) return item.minutes;
    return { 5: 15, 4: 30, 3: 45, 2: 90, 1: 120 }[item.ease] || 45;
  }

  const periodOf = ms => { const h = new Date(ms).getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };

  const DAY = 24 * HOUR;
  const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };

  // Split a task into work sessions: full chunks, then a remainder (never shorter than minSession).
  function splitSessions(total, chunk, minSession, maxSingle) {
    if (total <= (maxSingle || 0)) return [Math.max(total, minSession)]; // short enough to do in one go
    const out = [];
    let left = total;
    while (left > 0) {
      if (left <= chunk) { out.push(Math.max(left, minSession)); break; }
      out.push(chunk); left -= chunk;
    }
    return out.length ? out : [minSession];
  }

  // Put every task after the tasks it says it must follow (item.after = [ids]), otherwise keep priority order.
  function orderByDeps(items) {
    const byId = new Map(items.map(i => [i.id, i]));
    const out = [], seen = new Set(), stack = new Set();
    const visit = i => {
      if (seen.has(i.id) || stack.has(i.id)) return; // stack: ignore cycles
      stack.add(i.id);
      for (const pid of i.after || []) { const p = byId.get(pid); if (p) visit(p); }
      stack.delete(i.id); seen.add(i.id); out.push(i);
    };
    items.forEach(visit);
    return out;
  }

  // Give each task (already in priority order) its work sessions in the free gaps.
  //  - big tasks get several sessions (default 90 min), at most one per day, spaced out
  //  - work on a deadlined task opens max(7 days, 3 days per session) before the deadline, not earlier
  //  - sessions never overlap, never run past the deadline, and prefer the task's best time of day
  // Returns Map(id -> {start,end,minutes (first session), blocks:[{start,end,minutes,k}], sessions, fits, none, later, opensAt})
  //   fits=false : not all sessions fit before the deadline;  later: work starts after the planning horizon;  none: no free gap at all
  function planTasks(items, slotsIn, now, opts) {
    const o = Object.assign({ chunk: 90, buffer: 10, prefer: 48 * HOUR, max: 20, minSession: 30, lead: 7, perSession: 3, maxSingle: 120 }, opts);
    let slots = slotsIn.map(s => s.slice());
    const plan = new Map();
    for (const it of orderByDeps(items.slice(0, o.max))) {
      const total = defaultMinutes(it);
      const lens = splitSessions(total, o.chunk, o.minSession, o.maxSingle);
      const n = lens.length;
      const deadline = it.when && it.when > now ? it.when : null;
      const opensAt = deadline ? Math.max(now, deadline - Math.max(o.lead, n * o.perSession) * DAY) : now;
      const availDays = deadline ? Math.max(1, (deadline - opensAt) / DAY) : 1;
      const gap = n > 1 ? Math.max(1, Math.floor(availDays / (n + 1))) : 1;
      const blocks = [];
      // must come after its prerequisites: start once their last session ends; if one has no sessions yet, wait too
      let depEnd = 0, waiting = false;
      for (const pid of it.after || []) {
        const pp = plan.get(pid);
        if (!pp) continue;
        if (pp.blocks.length) depEnd = Math.max(depEnd, pp.blocks[pp.blocks.length - 1].end); else waiting = true;
      }
      // give related tasks a night in between when the deadline allows it, otherwise follow straight on
      let notBefore = Math.max(opensAt, depEnd);
      if (depEnd) {
        const nextDay = Math.max(opensAt, addDays(dayStart(depEnd), 1)), firstNeed = lens[0] * MIN;
        const room = nb => slots.some(sl => { const st = Math.max(sl[0], nb); return sl[1] - st >= firstNeed && (!deadline || st + firstNeed <= deadline); });
        if (room(nextDay)) notBefore = nextDay;
      }
      let fits = true;
      for (let k = 0; k < n && !waiting; k++) {
        const need = lens[k] * MIN;
        // candidate start inside each slot, no earlier than notBefore
        const cands = slots.map(sl => ({ sl, start: Math.max(sl[0], notBefore) })).filter(c => sl_end(c) - c.start >= need);
        function sl_end(c) { return c.sl[1]; }
        const feas = deadline ? cands.filter(c => c.start + need <= deadline) : cands;
        let pool = feas, late = false;
        if (!feas.length) {
          if (!cands.length) break;                         // no room left in the planning horizon
          if (k > 0) { fits = false; break; }               // later sessions can't meet the deadline
          pool = cands; fits = false; late = true;          // first session: show the earliest gap, flagged
        }
        let pick = pool[0];
        if (it.bestTime && it.bestTime !== 'anytime' && !late) {
          const near = pool.find(c => c.start - pool[0].start <= o.prefer && periodOf(c.start) === it.bestTime);
          if (near) pick = near;
        }
        const start = pick.start, end = start + need;
        blocks.push({ start, end, minutes: lens[k], k: k + 1 });
        // reserve the time (plus a small buffer)
        const next = [];
        for (const sl of slots) {
          if (sl !== pick.sl) { next.push(sl); continue; }
          if (start - sl[0] >= 10 * MIN) next.push([sl[0], start]);
          if (sl[1] - (end + o.buffer * MIN) >= 10 * MIN) next.push([end + o.buffer * MIN, sl[1]]);
        }
        slots = next.sort((x, y) => x[0] - y[0]);
        notBefore = addDays(dayStart(start), gap);
      }
      const first = blocks[0];
      const later = waiting || (!first && opensAt > now && slotsIn.length > 0 && opensAt >= slotsIn[slotsIn.length - 1][1]);
      plan.set(it.id, {
        start: first ? first.start : null, end: first ? first.end : null, minutes: first ? first.minutes : lens[0],
        blocks, sessions: n, session: 1, total, fits, opensAt, later, none: !first && !later,
      });
    }
    return plan;
  }

  const api = { expandEvents, freeSlots, defaultMinutes, planTasks, splitSessions, orderByDeps, periodOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FQSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
