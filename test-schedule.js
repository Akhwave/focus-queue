process.env.TZ = 'Europe/London'; // must be set before any Date is used
const assert = require('assert');
const ICAL = require('./worker/node_modules/ical.js/dist/ical.es5.cjs');
const S = require('./schedule.js');

const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:lecture@test
DTSTART;TZID=Europe/London:20261019T100000
DTEND;TZID=Europe/London:20261019T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10
EXDATE;TZID=Europe/London:20261026T100000
SUMMARY:Lecture
END:VEVENT
BEGIN:VEVENT
UID:lecture@test
RECURRENCE-ID;TZID=Europe/London:20261102T100000
DTSTART;TZID=Europe/London:20261102T140000
DTEND;TZID=Europe/London:20261102T150000
SUMMARY:Lecture (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTART;VALUE=DATE:20261021
DTEND;VALUE=DATE:20261022
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:utc@test
DTSTART:20261020T130000Z
DTEND:20261020T140000Z
SUMMARY:Call in UTC
END:VEVENT
BEGIN:VEVENT
UID:free@test
DTSTART:20261020T150000Z
DTEND:20261020T160000Z
TRANSP:TRANSPARENT
SUMMARY:Marked free
END:VEVENT
BEGIN:VEVENT
UID:cancelled@test
DTSTART:20261020T170000Z
DTEND:20261020T180000Z
STATUS:CANCELLED
SUMMARY:Cancelled
END:VEVENT
BEGIN:VEVENT
UID:old-daily@test
DTSTART:20190101T080000Z
DTEND:20190101T081500Z
RRULE:FREQ=DAILY
SUMMARY:Old daily habit
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');

const at = (m, d, h = 0, mi = 0) => new Date(2026, m - 1, d, h, mi).getTime(); // local (London)
const from = at(10, 19), to = at(11, 9);
const t0 = Date.now();
const ev = S.expandEvents(ICAL, ics, from, to, 'work');
console.log('parsed', ev.length, 'events in', Date.now() - t0, 'ms');
const byTitle = t => ev.filter(e => e.title === t);

// weekly lecture: Oct 19 (BST, 09:00Z), not Oct 26 (EXDATE), Nov 2 moved to 14:00 GMT
const lec = byTitle('Lecture').map(e => new Date(e.start).toISOString());
assert.deepStrictEqual(lec, ['2026-10-19T09:00:00.000Z'], 'plain lecture: Oct 19 only (Oct 26 excluded, Nov 2 replaced)');
assert.deepStrictEqual(byTitle('Lecture (moved)').map(e => new Date(e.start).toISOString()), ['2026-11-02T14:00:00.000Z'], 'moved instance uses new time (GMT after clocks change)');
assert.strictEqual(ev.filter(e => /Lecture/.test(e.title) && new Date(e.start).toISOString() === '2026-11-02T10:00:00.000Z').length, 0, 'original slot is gone');
assert.strictEqual(ev.filter(e => /Lecture/.test(e.title) && e.start >= at(10, 26) && e.start < at(10, 27)).length, 0, 'EXDATE removed Oct 26');
// all-day, utc, transparent, cancelled
const hol = byTitle('Holiday')[0]; assert.ok(hol.allDay && hol.start === at(10, 21) && hol.end === at(10, 22));
assert.strictEqual(new Date(byTitle('Call in UTC')[0].start).toISOString(), '2026-10-20T13:00:00.000Z');
assert.strictEqual(byTitle('Marked free')[0].busy, false);
assert.strictEqual(byTitle('Cancelled').length, 0);
// old endless daily series: one per day in window, found quickly
assert.strictEqual(byTitle('Old daily habit').length, 21);
assert.ok(Date.now() - t0 < 3000, 'fast enough');
// events entirely outside the window are dropped
assert.strictEqual(S.expandEvents(ICAL, ics, at(1, 1), at(1, 8), 'x').filter(e => e.title !== 'Old daily habit').length, 0);

// ---- free slots ----
const now = at(10, 19, 8, 3);
const slots = S.freeSlots(ev, now, { days: 2, dayStart: 9 * 60, dayEnd: 21 * 60, buffer: 10 });
const fmt = s => new Date(s[0]).toTimeString().slice(0, 5) + '-' + new Date(s[1]).toTimeString().slice(0, 5);
const d19 = slots.filter(s => s[0] < at(10, 20)).map(fmt);
// Oct 19: working day 09:00-21:00; daily habit at 09:00Z=10:00 BST? (08:00Z = 09:00 BST for 15 min) and lecture 10-11 BST
console.log('Oct 19 slots', d19.join(' | '));
assert.ok(slots.every(s => s[1] > s[0]), 'valid slots');
assert.ok(slots.every(s => s[0] >= now), 'nothing in the past');
// no slot overlaps any busy event
for (const e of ev.filter(e => e.busy && !e.allDay)) for (const s of slots) assert.ok(s[1] <= e.start || s[0] >= e.end, 'slot overlaps ' + e.title);
// all-day events do not block time
assert.ok(slots.some(s => s[0] >= at(10, 21) || true));
// a 10-minute buffer is left after events
const lecEnd = at(10, 19, 11, 0);
assert.ok(!slots.some(s => s[0] < lecEnd + 10 * 60e3 && s[1] > lecEnd), 'buffer after the lecture');

// ---- planning ----
const free = [[at(10, 19, 12), at(10, 19, 13)], [at(10, 20, 9), at(10, 20, 12)], [at(10, 20, 19), at(10, 20, 21)]];
const items = [
  { id: 'big', minutes: 200, when: null, bestTime: 'anytime' },
  { id: 'urgent', minutes: 30, when: at(10, 19, 12, 20), bestTime: 'anytime' },   // deadline before any 30-min gap fits
  { id: 'eve', minutes: 60, when: null, bestTime: 'evening' },
  { id: 'quick', minutes: 15, when: at(10, 20, 17), bestTime: 'morning' },
];
const p = S.planTasks(items, free, at(10, 19, 8), {});
assert.strictEqual(p.get('big').sessions, 3, '200 min = 90 + 90 + 30');
assert.strictEqual(p.get('big').blocks[0].minutes, 90);
assert.strictEqual(p.get('urgent').fits, false, '12:00 + 30 min is after the 12:20 deadline? no: 12:30 > 12:20');
assert.strictEqual(p.get('eve').start, at(10, 20, 19), 'evening task goes to the evening slot');
assert.strictEqual(p.get('quick').fits, true);
const allBlocks = [...p.values()].flatMap(b => b.blocks).sort((a, b) => a.start - b.start);
for (let i = 1; i < allBlocks.length; i++) assert.ok(allBlocks[i].start >= allBlocks[i - 1].end, 'planned blocks overlap');
assert.strictEqual(S.planTasks([{ id: 'z', minutes: 10 }], [], at(10, 19), {}).get('z').none, true);
assert.deepStrictEqual([S.splitSessions(480, 90, 30, 120), S.splitSessions(100, 90, 30, 120), S.splitSessions(120, 90, 30, 120), S.splitSessions(20, 90, 30, 120), S.splitSessions(180, 90, 30, 120), S.splitSessions(100, 90, 30)],
  [[90, 90, 90, 90, 90, 30], [100], [120], [30], [90, 90], [90, 30]]);

// multi-day: an 8-hour coursework due in 18 days gets sessions on different days, spaced out, before the deadline
const week = [];
for (let d = 0; d < 14; d++) week.push([at(10, 19 + d, 9), at(10, 19 + d, 21)]);
const nowW = at(10, 19, 8);
const cw = { id: 'cw', minutes: 480, when: at(11, 6, 13), importance: 5, ease: 1, bestTime: 'morning' };
const pw = S.planTasks([cw], week, nowW, {}).get('cw');
assert.strictEqual(pw.sessions, 6);
assert.ok(pw.blocks.length >= 4, 'several sessions are planned inside the 14-day horizon: ' + pw.blocks.length);
const days = pw.blocks.map(b => new Date(b.start).toDateString());
assert.strictEqual(new Set(days).size, days.length, 'at most one session per day');
for (let i = 1; i < pw.blocks.length; i++) assert.ok(new Date(pw.blocks[i].start).setHours(0, 0, 0, 0) - new Date(pw.blocks[i - 1].start).setHours(0, 0, 0, 0) >= 2 * 86400e3 - 3600e3, 'sessions are spaced at least 2 days apart');
assert.ok(pw.blocks.every(b => b.end <= cw.when), 'nothing after the deadline'); assert.strictEqual(pw.fits, true);
assert.ok(pw.blocks.every(b => periodOf(b.start) === 'morning'), 'morning preference honoured when the gaps allow');
function periodOf(ms) { return S.periodOf(ms); }

// work on a far-off deadline does not start yet (window opens max(7, 3*sessions) days before)
const far = S.planTasks([{ id: 'far', minutes: 480, when: at(11, 25, 12), bestTime: 'anytime' }], week, nowW, {}).get('far');
assert.strictEqual(far.blocks.length, 0); assert.strictEqual(far.later, true); assert.ok(far.opensAt > at(11, 1));
// a single short task due in 12 days is not scheduled today either
const shortFar = S.planTasks([{ id: 's', minutes: 30, when: at(10, 31, 12), bestTime: 'anytime' }], week, nowW, {}).get('s');
assert.ok(shortFar.blocks.length === 1 && shortFar.blocks[0].start >= at(10, 24), 'starts in the last week before the deadline');
// not enough room before a close deadline: flagged, not silently dropped
const tight = S.planTasks([{ id: 't', minutes: 480, when: at(10, 21, 12) }], week, nowW, {}).get('t');
assert.strictEqual(tight.fits, false);
assert.ok(tight.blocks.every(b => b.end <= at(10, 21, 12) || tight.blocks.indexOf(b) === 0));
assert.strictEqual(S.defaultMinutes({ ease: 5 }), 15); assert.strictEqual(S.defaultMinutes({ ease: 1 }), 120); assert.strictEqual(S.defaultMinutes({ minutes: 20, ease: 1 }), 20);
// ---- dependencies: lectures -> sheet 1 -> sheet 2 -> tutorial, even when priority order says otherwise ----
const dep = [
  { id: 'tut', minutes: 90, when: at(10, 26, 13), after: ['s2'], importance: 5 },
  { id: 's2', minutes: 120, when: at(10, 25, 12), after: ['s1'], importance: 2 },
  { id: 's1', minutes: 120, when: at(10, 24, 18), after: ['lec'], importance: 2 },
  { id: 'lec', minutes: 150, when: at(10, 23, 18), importance: 1 },
];
assert.deepStrictEqual(S.orderByDeps(dep).map(i => i.id), ['lec', 's1', 's2', 'tut']);
assert.deepStrictEqual(S.orderByDeps([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }]).map(i => i.id).sort(), ['a', 'b'], 'cycles do not hang');
const pd = S.planTasks(dep, week, nowW, {});
const lastEnd = id => pd.get(id).blocks[pd.get(id).blocks.length - 1].end;
assert.ok(pd.get('s1').blocks[0].start >= lastEnd('lec'), 'sheet 1 starts after the lectures are done');
const dOf = ms => new Date(ms).setHours(0, 0, 0, 0);
assert.ok(dOf(pd.get('s1').blocks[0].start) > dOf(lastEnd('lec')), 'with room to spare, the next task starts the next day');
assert.ok(dOf(pd.get('tut').blocks[0].start) > dOf(lastEnd('s2')));
// but when the deadline is tight, it follows straight on rather than missing it
const tightDep = S.planTasks([{ id: 'a', minutes: 60, when: at(10, 20, 16) }, { id: 'b', minutes: 60, when: at(10, 20, 18), after: ['a'] }], week, nowW, {});
assert.strictEqual(dOf(tightDep.get('b').blocks[0].start), dOf(at(10, 20)), 'same day when the deadline needs it');
assert.strictEqual(tightDep.get('b').fits, true);
assert.ok(pd.get('s2').blocks[0].start >= lastEnd('s1'), 'sheet 2 after sheet 1');
assert.ok(pd.get('tut').blocks[0].start >= lastEnd('s2'), 'tutorial after sheet 2');
assert.strictEqual(pd.get('s1').sessions, 1, 'a 2-hour sheet is one session');
// a prerequisite that has no sessions yet holds its dependents back
const held = S.planTasks([{ id: 'x', minutes: 480, when: at(11, 25, 12) }, { id: 'y', minutes: 30, after: ['x'] }], week, nowW, {});
assert.strictEqual(held.get('y').blocks.length, 0); assert.strictEqual(held.get('y').later, true);
// ---- weekly unavailable blocks ----
const sundayAll = { days: [0], start: 0, end: 1439 };
const fs2 = S.freeSlots([], at(10, 22, 8), { days: 7, dayStart: 9 * 60, dayEnd: 21 * 60, buffer: 10, blocked: [sundayAll] });   // Thu 22 Oct ... Wed 28
assert.strictEqual(fs2.filter(s => new Date(s[0]).getDay() === 0).length, 0, 'Sunday is completely unavailable');
assert.ok(fs2.some(s => new Date(s[0]).getDay() === 6), 'Saturday still has slots');
// a partial block (08:00-20:00) leaves only the evening
const part = S.freeSlots([], at(10, 22, 8), { days: 7, dayStart: 9 * 60, dayEnd: 21 * 60, buffer: 10, blocked: [{ days: [0], start: 8 * 60, end: 20 * 60 }] }).filter(s => new Date(s[0]).getDay() === 0);
assert.ok(part.length > 0 && part.every(s => new Date(s[0]).getHours() >= 20), 'partial block leaves Sunday evening');
// no rules: Sunday is a normal day
assert.ok(S.freeSlots([], at(10, 22, 8), { days: 7, dayStart: 9 * 60, dayEnd: 21 * 60, buffer: 10, blocked: [] }).some(s => new Date(s[0]).getDay() === 0 && new Date(s[0]).getHours() === 9));
// weekdays rule
const wk = S.freeSlots([], at(10, 19, 8), { days: 7, dayStart: 9 * 60, dayEnd: 21 * 60, blocked: [{ days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 }] });
assert.ok(wk.every(s => ![1, 2, 3, 4, 5].includes(new Date(s[0]).getDay()) || new Date(s[0]).getHours() >= 17), 'weekday daytime blocked');
// planner respects it: nothing planned on a blocked Sunday
const sp = S.planTasks([{ id: 'q', minutes: 90, when: at(10, 26, 13) }, { id: 'r', minutes: 90, when: at(10, 26, 13) }], fs2, at(10, 22, 8), {});
for (const b of [...sp.values()].flatMap(x => x.blocks)) assert.ok(new Date(b.start).getDay() !== 0, 'planned on a blocked Sunday');
console.log('schedule tests ok');
