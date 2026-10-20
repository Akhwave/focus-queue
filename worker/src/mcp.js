// MCP server (streamable HTTP, stateless JSON) so claude.ai can add, list and complete tasks.
// Reached at /mcp/<MCP_KEY>; the key is a Worker secret and acts as the password.
const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List the open tasks in Focus Queue, soonest deadline first. Times are UK local time. Use this before planning or when asked what to do next.',
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean', description: 'Also show finished tasks (last 20)' } } },
  },
  {
    name: 'add_task',
    description: 'Add a task or event to Focus Queue. Use importance 1-5 (5 = critical) and ease 1-5 (5 = very easy). The app syncs it to the phone and laptop within about 15 seconds.',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: {
        title: { type: 'string' },
        due: { type: 'string', description: 'Deadline in UK local time, "YYYY-MM-DD HH:MM". Leave out for no deadline.' },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
        ease: { type: 'integer', minimum: 1, maximum: 5 },
        minutes: { type: 'integer', description: 'Estimated work time in minutes' },
        notes: { type: 'string' },
        after: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must be done first' },
        id: { type: 'string', description: 'Optional short id, lowercase with dashes' },
        type: { type: 'string', enum: ['task', 'event', 'habit'] },
      },
    },
  },
  {
    name: 'update_task',
    description: 'Change fields of an existing task by id (title, due, importance, ease, minutes, notes, after). Pass due as "" to remove the deadline.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' }, importance: { type: 'integer' },
        ease: { type: 'integer' }, minutes: { type: 'integer' }, notes: { type: 'string' }, after: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done (or not done again with done=false) by id.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, done: { type: 'boolean' } } },
  },
  {
    name: 'delete_task',
    description: 'Delete a task by id. Only do this when the user clearly asks.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
];

// "2026-10-30 18:00" in Europe/London -> epoch ms (handles BST/GMT)
function londonToMs(s) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const m = String(s).match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/);
  if (!m) throw new Error('due must look like "2026-10-30 18:00" (UK time)');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
    guess += want - Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute);
  }
  return guess;
}
const ukTime = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

const clamp = (n, lo, hi, def) => Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : def;

async function load(env) {
  const stub = env.STORE.get(env.STORE.idFromName('main'));
  const res = await stub.fetch('https://store/', { method: 'GET' });
  const cur = await res.json();
  const data = cur.data || { items: [], deleted: {}, settingsUpdated: 0 };
  data.deleted = data.deleted || {};
  return { stub, rev: cur.rev, data };
}

// read-modify-write with the same revision check the app uses; retries if the app wrote in between
async function mutate(env, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { stub, rev, data } = await load(env);
    const out = fn(data);
    const res = await stub.fetch('https://store/', { method: 'PUT', body: JSON.stringify({ baseRev: rev, data }) });
    if (res.status === 409) continue;
    if (!res.ok) throw new Error('save failed (' + res.status + ')');
    return out;
  }
  throw new Error('the app kept changing the data; try again');
}

const view = (i, now) => ({
  id: i.id, title: i.title, type: i.type, done: !!i.done,
  due: i.when ? ukTime(i.when) : null,
  overdue: !i.done && !!i.when && i.when < now,
  importance: i.importance, ease: i.ease, minutes: i.minutes || null,
  after: i.after && i.after.length ? i.after : undefined,
  notes: i.notes ? String(i.notes).slice(0, 300) : undefined,
});

async function callTool(env, name, a) {
  const now = Date.now();
  if (name === 'list_tasks') {
    const { data } = await load(env);
    const open = data.items.filter(i => !i.done && i.type !== 'event').sort((x, y) => (x.when || Infinity) - (y.when || Infinity));
    const out = { now: ukTime(now), open: open.map(i => view(i, now)) };
    if (a.include_done) out.done = data.items.filter(i => i.done).sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0)).slice(0, 20).map(i => view(i, now));
    return out;
  }
  if (name === 'add_task') {
    if (!a.title || typeof a.title !== 'string') throw new Error('title is required');
    const slug = String(a.id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const item = {
      id: slug || 'task-' + a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + now.toString(36),
      title: a.title.slice(0, 200), type: ['task', 'event', 'habit'].includes(a.type) ? a.type : 'task',
      when: a.due ? londonToMs(a.due) : null,
      importance: clamp(a.importance, 1, 5, 3), ease: clamp(a.ease, 1, 5, 3), minutes: a.minutes ? clamp(a.minutes, 5, 2000, null) : null,
      notes: String(a.notes || '').slice(0, 2000), steps: [], after: Array.isArray(a.after) ? a.after.map(String) : [], repeat: 'none',
      done: false, doneAt: null, created: now, updated: now, bestTime: 'anytime', why: '',
    };
    // values given are final unless the caller leaves scoring out, in which case the app's AI scores it
    if (a.importance != null && a.ease != null) item.ai = now;
    return mutate(env, data => {
      if (data.items.some(i => i.id === item.id)) throw new Error('a task with id ' + item.id + ' already exists');
      data.items.push(item);
      return { added: view(item, now) };
    });
  }
  if (name === 'update_task' || name === 'complete_task' || name === 'delete_task') {
    return mutate(env, data => {
      const it = data.items.find(i => i.id === a.id);
      if (!it) throw new Error('no task with id ' + a.id);
      if (name === 'delete_task') {
        data.items = data.items.filter(i => i.id !== a.id);
        data.deleted[a.id] = now;
        return { deleted: a.id };
      }
      if (name === 'complete_task') {
        const done = a.done !== false;
        it.done = done; it.doneAt = done ? now : null;
      } else {
        if (typeof a.title === 'string' && a.title) it.title = a.title.slice(0, 200);
        if (a.due !== undefined) it.when = a.due ? londonToMs(a.due) : null;
        if (a.importance != null) it.importance = clamp(a.importance, 1, 5, it.importance);
        if (a.ease != null) it.ease = clamp(a.ease, 1, 5, it.ease);
        if (a.minutes != null) it.minutes = clamp(a.minutes, 5, 2000, it.minutes);
        if (typeof a.notes === 'string') it.notes = a.notes.slice(0, 2000);
        if (Array.isArray(a.after)) it.after = a.after.map(String);
        it.ai = now;
      }
      it.updated = now;
      return { updated: view(it, now) };
    });
  }
  throw new Error('unknown tool ' + name);
}

export async function handleMcp(req, env) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const key = new URL(req.url).pathname.split('/')[2] || '';
  if (!env.MCP_KEY || !safeEq(key, env.MCP_KEY)) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let msg;
  try { msg = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }

  const handle = async m => {
    if (!m || m.id === undefined) return null;   // notifications get no reply
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    const bad = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'focus-queue', version: '1.0.0' },
          instructions: 'Kelvin\'s task tracker. Times are UK local time. Call list_tasks before planning. Tasks sync to his phone and laptop.' });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const p = m.params || {};
        if (!TOOLS.some(t => t.name === p.name)) return bad(-32602, 'unknown tool');
        try {
          const out = await callTool(env, p.name, p.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return ok({ isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] });
        }
      }
      default: return bad(-32601, 'method not found');
    }
  };

  if (Array.isArray(msg)) {
    const outs = (await Promise.all(msg.map(handle))).filter(Boolean);
    return outs.length ? json(outs) : new Response(null, { status: 202 });
  }
  const out = await handle(msg);
  return out ? json(out) : new Response(null, { status: 202 });
}

function safeEq(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

export { callTool, TOOLS };
