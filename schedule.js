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
    const busy = events.filter(e => e.busy && !e.allDay).map(e => [e.start, e.end + o.buffer * MIN]).sort((a, b) => a[0] - b[0]);
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

  // Give each task (already in priority order) a time slot. Earlier tasks get first pick and slots never overlap.
  // Returns Map(id -> {start, end, minutes, fits, session, sessions}) ; fits=false means no gap before the deadline.
  function planTasks(items, slotsIn, now, opts) {
    const o = Object.assign({ chunk: 90, buffer: 10, prefer: 48 * HOUR, max: 12 }, opts);
    let slots = slotsIn.map(s => s.slice());
    const plan = new Map();
    for (const it of items.slice(0, o.max)) {
      const total = defaultMinutes(it);
      const minutes = Math.min(total, o.chunk);
      const need = minutes * MIN;
      const deadline = it.when && it.when > now ? it.when : null;
      const fitsSlot = s => s[1] - s[0] >= need && (!deadline || s[0] + need <= deadline);
      let feasible = slots.filter(fitsSlot), fits = true;
      if (!feasible.length) { feasible = slots.filter(s => s[1] - s[0] >= need); fits = !deadline ? true : false; }
      if (!feasible.length) { plan.set(it.id, { start: null, end: null, minutes, fits: false, none: true }); continue; }
      let pick = feasible[0];
      if (it.bestTime && it.bestTime !== 'anytime') {
        const near = feasible.find(s => s[0] - feasible[0][0] <= o.prefer && periodOf(s[0]) === it.bestTime);
        if (near) pick = near;
      }
      const start = pick[0], end = start + need;
      plan.set(it.id, { start, end, minutes, fits, session: 1, sessions: Math.ceil(total / o.chunk) });
      // reserve the time (plus a small buffer) so the next task cannot take it
      const next = [];
      for (const s of slots) {
        if (s !== pick) { next.push(s); continue; }
        if (start - s[0] >= 10 * MIN) next.push([s[0], start]);
        if (s[1] - (end + o.buffer * MIN) >= 10 * MIN) next.push([end + o.buffer * MIN, s[1]]);
      }
      slots = next.sort((a, b) => a[0] - b[0]);
    }
    return plan;
  }

  const api = { expandEvents, freeSlots, defaultMinutes, planTasks, periodOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FQSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
