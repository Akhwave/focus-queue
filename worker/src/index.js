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
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Vary': 'Origin',
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    if (path !== '/data' && path !== '/ai') return reply({ error: 'not found' }, 404);

    const got = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!env.TOKEN || !safeEqual(got, env.TOKEN)) return reply({ error: 'unauthorized' }, 401);

    if (path === '/ai') return ai(req, env, reply);

    const stub = env.STORE.get(env.STORE.idFromName('main'));
    const res = await stub.fetch('https://store/', { method: req.method, body: req.method === 'PUT' ? await req.text() : undefined });
    return reply(await res.json(), res.status);
  },
};

// Runs a small text model on Cloudflare Workers AI (free daily allowance, no API key).
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
async function ai(req, env, reply) {
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  if (!env.AI) return reply({ error: 'AI not enabled on this Worker' }, 501);
  let body;
  try { body = await req.json(); } catch { return reply({ error: 'bad json' }, 400); }
  const { prompt, schema } = body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 8000 || !schema || typeof schema !== 'object') return reply({ error: 'bad request' }, 400);
  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: 'You are a careful assistant. Reply with JSON that matches the schema and nothing else.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_schema', json_schema: schema },
      max_tokens: 1500,
      temperature: 0.3,
    });
    let data = out && out.response;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return reply({ error: 'model returned invalid JSON' }, 502); } }
    if (!data || typeof data !== 'object') return reply({ error: 'model returned nothing' }, 502);
    return reply({ data });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/allocation|neurons|limit|quota/i.test(msg)) return reply({ error: 'Free daily AI limit reached. It resets at 00:00 UTC.' }, 429);
    return reply({ error: 'AI failed: ' + msg.slice(0, 120) }, 502);
  }
}

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
