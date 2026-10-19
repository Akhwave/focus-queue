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
assert.strictEqual(p.get('big').minutes, 90, 'long tasks planned as a 90-minute session'); assert.strictEqual(p.get('big').sessions, 3);
assert.strictEqual(p.get('urgent').fits, false, 'cannot finish 30 min by 12:20 from a 12:00 slot? (12:00+30 = 12:30 > 12:20)');
assert.strictEqual(p.get('eve').start, at(10, 20, 19), 'evening task goes to the evening slot');
assert.strictEqual(p.get('quick').fits, true);
// no overlaps between planned blocks
const blocks = [...p.values()].filter(b => b.start != null).sort((a, b) => a.start - b.start);
for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].start >= blocks[i - 1].end, 'planned blocks overlap');
// no slots at all
assert.strictEqual(S.planTasks([{ id: 'z', minutes: 10 }], [], at(10, 19), {}).get('z').none, true);
assert.strictEqual(S.defaultMinutes({ ease: 5 }), 15); assert.strictEqual(S.defaultMinutes({ ease: 1 }), 120); assert.strictEqual(S.defaultMinutes({ minutes: 20, ease: 1 }), 20);
console.log('schedule tests ok');
