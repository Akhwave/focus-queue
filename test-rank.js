const assert = require('assert');
const { fit, rank, applyTriage, DEFAULTS } = require('./app.js');
const at = h => new Date(2026, 9, 19, h, 0, 0).getTime();   // local time
const w = DEFAULTS;
assert.strictEqual(fit({ bestTime: 'morning' }, at(9)), 1);
assert.strictEqual(fit({ bestTime: 'morning' }, at(14)), 0.3);
assert.strictEqual(fit({ bestTime: 'morning' }, at(20)), 0.1);
assert.strictEqual(fit({ bestTime: 'anytime' }, at(9)), 0.5);
assert.strictEqual(fit({}, at(9)), 0.5);
// same task ranks higher in its best slot than outside it, nothing else changes
const call = { importance: 3, ease: 3, when: null, bestTime: 'morning' };
assert.ok(rank(call, at(9), w).score > rank(call, at(21), w).score, 'morning task ranks higher in the morning');
// weight 0 turns the factor off
assert.strictEqual(rank(call, at(9), { ...w, wFit: 0 }).score, rank(call, at(21), { ...w, wFit: 0 }).score);
// old saved weights without wFit still work
const old = { wImp: 5, wUrg: 5, wEase: 2 };
assert.ok(Number.isFinite(rank(call, at(9), old).score));

// applyTriage
const items = [{ id: 'a', importance: 3, ease: 3 }, { id: 'b', importance: 3, ease: 3, manual: true }, { id: 'c', importance: 3, ease: 3 }];
const n = applyTriage(items, { items: [
  { id: 'a', importance: 9, ease: 0, minutes: 25, bestTime: 'evening', why: 'x'.repeat(200) },
  { id: 'b', importance: 5, ease: 5, minutes: 5, bestTime: 'morning', why: 'nope' }] }, 123);
assert.strictEqual(n, 1);
assert.deepStrictEqual([items[0].importance, items[0].ease, items[0].minutes, items[0].bestTime, items[0].why.length, items[0].ai], [5, 1, 25, 'evening', 80, 123]);
assert.strictEqual(items[1].importance, 3, 'manual item untouched'); assert.strictEqual(items[1].ai, undefined);
assert.strictEqual(items[2].ai, -1, 'unanswered item marked so it is not re-asked forever');
// junk values are sanitised
const j = [{ id: 'z', importance: 3, ease: 3 }];
applyTriage(j, { items: [{ id: 'z', importance: 'high', ease: null, minutes: -4, bestTime: 'midnight', why: null }] }, 5);
assert.deepStrictEqual([j[0].importance, j[0].ease, j[0].minutes, j[0].bestTime, j[0].why], [3, 3, undefined, 'anytime', '']);
// breakdown: steps are added only when the task has none, and are cleaned
const st = [{ id: 's', importance: 3, ease: 3 }, { id: 't', importance: 3, ease: 3, steps: [{ text: 'mine', done: false }] }];
applyTriage(st, { items: [
  { id: 's', importance: 3, ease: 1, minutes: 90, bestTime: 'anytime', why: 'big', steps: ['  open the file ', '', 'x'.repeat(300), ...Array(20).fill('more')] },
  { id: 't', importance: 3, ease: 1, minutes: 90, bestTime: 'anytime', why: 'big', steps: ['AI step'] }] }, 9);
assert.strictEqual(st[0].steps.length, 12); assert.strictEqual(st[0].steps[0].text, 'open the file');
assert.strictEqual(st[0].steps[1].text.length, 100);
assert.deepStrictEqual(st[1].steps, [{ text: 'mine', done: false }], 'existing steps kept');
const { stepCount } = require('./app.js');
assert.deepStrictEqual([stepCount(1), stepCount(2), stepCount(3), stepCount(undefined)], ['2 to 4', '4 to 7', '7 to 12', '4 to 7']);
const { toGemini } = require('./app.js');
assert.deepStrictEqual(toGemini({ type: 'object', properties: { a: { type: 'array', items: { type: 'string', enum: ['x'] } }, n: { type: 'integer' } }, required: ['a'] }),
  { type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'STRING', enum: ['x'] } }, n: { type: 'INTEGER' } }, required: ['a'] });
const { alignResults } = require('./app.js');
const sent = [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }];
// ids match (any order)
let a = alignResults(sent, { items: [{ id: 'x3', importance: 1 }, { id: 'x1', importance: 2 }] });
assert.deepStrictEqual(a.items.map(i => [i.id, i.importance]), [['x1', 2], ['x3', 1]]);
// ids mangled but same count: use position
a = alignResults(sent, { items: [{ id: '1', importance: 5 }, { id: '2', importance: 4 }, { id: '3', importance: 3 }] });
assert.deepStrictEqual(a.items.map(i => [i.id, i.importance]), [['x1', 5], ['x2', 4], ['x3', 3]]);
// ids mangled and count differs: apply nothing rather than guess
a = alignResults(sent, { items: [{ id: '1', importance: 5 }] }); assert.strictEqual(a.items.length, 0);
assert.strictEqual(alignResults(sent, null).items.length, 0); assert.strictEqual(alignResults(sent, { items: 'junk' }).items.length, 0);
console.log('rank tests ok');
