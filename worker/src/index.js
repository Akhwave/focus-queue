// One Durable Object holds your data as {rev, data}. Strongly consistent, so two devices
// can't overwrite each other: a write must name the revision it was based on.
const MAX_BYTES = 1_000_000;

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Vary': 'Origin',
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(req.url).pathname !== '/data') return reply({ error: 'not found' }, 404);

    const got = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!env.TOKEN || !safeEqual(got, env.TOKEN)) return reply({ error: 'unauthorized' }, 401);

    const stub = env.STORE.get(env.STORE.idFromName('main'));
    const res = await stub.fetch('https://store/', { method: req.method, body: req.method === 'PUT' ? await req.text() : undefined });
    return reply(await res.json(), res.status);
  },
};

export class Store {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const cur = (await this.state.storage.get('doc')) || { rev: 0, data: null };
    if (req.method === 'GET') return Response.json(cur);
    if (req.method !== 'PUT') return Response.json({ error: 'method' }, { status: 405 });
    const text = await req.text();
    if (text.length > MAX_BYTES) return Response.json({ error: 'too large' }, { status: 413 });
    let body;
    try { body = JSON.parse(text); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
    if (!body || typeof body.data !== 'object' || !Array.isArray(body.data.items)) return Response.json({ error: 'bad shape' }, { status: 400 });
    if (body.baseRev !== cur.rev) return Response.json(cur, { status: 409 });
    const next = { rev: cur.rev + 1, data: body.data };
    await this.state.storage.put('doc', next);
    return Response.json({ rev: next.rev });
  }
}
