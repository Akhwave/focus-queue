const assert = require('assert');
const { mergeData } = require('./app.js');
const T = 1e12, now = Date.now();
const it = (id, updated, extra = {}) => ({ id, title: id, updated, ...extra });
const w = { wImp: 5, wUrg: 5, wEase: 2 };
const A = { items: [it('a', now - 10), it('b', now - 10)], deleted: {}, settingsUpdated: 1, weights: w };
const B = { items: [it('a', now - 5, { title: 'a2' }), it('c', now - 5)], deleted: { b: now - 1 }, settingsUpdated: 2, weights: { ...w, wImp: 9 } };
const m = mergeData(A, B);
assert.deepStrictEqual(m.items.map(i => i.id), ['a', 'c'], 'union, deleted b gone');
assert.strictEqual(m.items[0].title, 'a2', 'newer edit wins');
assert.strictEqual(m.weights.wImp, 9, 'newer settings win');
// symmetric
const m2 = mergeData(B, A);
assert.deepStrictEqual(m2.items, m.items); assert.deepStrictEqual(m2.weights, m.weights);
// edit after delete resurrects (LWW); delete after edit stays deleted
const r = mergeData({ items: [it('x', now)], deleted: {} }, { items: [], deleted: { x: now - 100 } });
assert.strictEqual(r.items.length, 1);
const d = mergeData({ items: [it('x', now - 100)], deleted: {} }, { items: [], deleted: { x: now } });
assert.strictEqual(d.items.length, 0);
// idempotent
assert.deepStrictEqual(mergeData(m, m).items, m.items);
// old tombstones pruned
const p = mergeData({ items: [], deleted: { old: 1 } }, { items: [], deleted: {} });
assert.deepStrictEqual(p.deleted, {});
console.log('merge tests ok');
