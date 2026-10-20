import assert from 'node:assert';
import { handleMcp } from './.mcp-test.mjs';
let doc = { rev: 0, data: { items: [{ id: 'a', title: 'A', type: 'task', when: Date.parse('2026-10-26T13:00:00Z'), importance: 3, ease: 3, done: false, updated: 1 }], deleted: {} } };
const stub = { fetch: async (_u, o) => {
  if (o.method === 'GET') return Response.json(doc);
  const b = JSON.parse(o.body); if (b.baseRev !== doc.rev) return Response.json(doc, { status: 409 });
  doc = { rev: doc.rev + 1, data: b.data }; return Response.json({ rev: doc.rev });
} };
const env = { MCP_KEY: 'k', STORE: { idFromName: () => 1, get: () => stub } };
const rpc = async (body, key = 'k') => handleMcp(new Request('https://x/mcp/' + key, { method: 'POST', body: JSON.stringify(body) }), env);
const call = async (name, args) => JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()).result.content[0].text);

assert.strictEqual((await rpc({}, 'bad')).status, 404);
const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
assert.strictEqual(init.result.serverInfo.name, 'focus-queue');
assert.strictEqual((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
assert.strictEqual((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools.length, 5);
const added = await call('add_task', { title: 'ML sheet 3', due: '2026-10-30 18:00', importance: 4, ease: 2, minutes: 120, after: ['a'], id: 'ml-sheet3' });
assert.strictEqual(added.added.id, 'ml-sheet3');
assert.strictEqual(doc.data.items.find(i => i.id === 'ml-sheet3').when, Date.parse('2026-10-30T18:00:00Z'));   // BST ended 25 Oct: GMT
assert.strictEqual(doc.data.items.find(i => i.id === 'ml-sheet3').ai > 0, true);
assert.strictEqual(Date.parse('2026-10-20T08:00:00Z') < doc.data.items[1].created + 1e12, true);
const l = await call('list_tasks', {});
assert.deepStrictEqual(l.open.map(i => i.id), ['a', 'ml-sheet3']);
await call('complete_task', { id: 'a' });
assert.strictEqual(doc.data.items[0].done, true);
await call('update_task', { id: 'ml-sheet3', due: '', importance: 5 });
assert.strictEqual(doc.data.items[1].when, null);
await call('delete_task', { id: 'ml-sheet3' });
assert.ok(doc.data.deleted['ml-sheet3'] && doc.data.items.length === 1);
const err = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'complete_task', arguments: { id: 'zzz' } } })).json();
assert.strictEqual(err.result.isError, true);
// a BST date maps correctly
await call('add_task', { title: 'x', due: '2026-10-22 12:00', id: 'x' });
assert.strictEqual(doc.data.items.find(i => i.id === 'x').when, Date.parse('2026-10-22T11:00:00Z'));
console.log('mcp tests ok');
