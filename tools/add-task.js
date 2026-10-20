#!/usr/bin/env node
// Add a task to the Focus Queue via the sync server.
//   node tools/add-task.js --title "ML problem sheet 3" --when "2026-10-30 18:00" --importance 3 --ease 2 --minutes 120 \
//        --after canvas-ml-sheet2 --notes "link or detail" --tag University --id ml-sheet3 [--ai] [--dry-run]
// --when is UK local time ("YYYY-MM-DD HH:MM"), or a full ISO string with a zone. Omit it for no deadline.
// --ai   : leave scoring to the AI (importance/ease/minutes/steps) instead of the values given.
// The sync key is read from $FOCUSQ_KEY or from ~/.focusq-key. Server: $FOCUSQ_URL or the default below.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const URL_BASE = (process.env.FOCUSQ_URL || 'https://focus-sync.edewikelvin.workers.dev') + '/data';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); }
const key = (process.env.FOCUSQ_KEY || (fs.existsSync(path.join(os.homedir(), '.focusq-key')) ? fs.readFileSync(path.join(os.homedir(), '.focusq-key'), 'utf8') : '')).trim();

// "2026-10-30 18:00" in Europe/London -> epoch ms (handles BST/GMT)
function londonToMs(s) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/);
  if (!m) throw new Error('bad --when: ' + s);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const shown = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}

(async () => {
  const title = arg('title');
  if (!title || title === true) throw new Error('--title is required');
  if (!key) throw new Error('no sync key: set FOCUSQ_KEY or put it in ~/.focusq-key');
  const now = Date.now();
  const slug = String(arg('id', title)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const item = {
    id: arg('id') ? slug : `task-${slug}-${now.toString(36)}`, title, type: arg('type', 'task'),
    when: arg('when') ? londonToMs(String(arg('when'))) : null,
    importance: +arg('importance', 3), ease: +arg('ease', 3), minutes: arg('minutes') ? +arg('minutes') : null,
    notes: String(arg('notes', '')), tag: String(arg('tag', '') === true ? '' : arg('tag', '')), steps: [], after: arg('after') ? String(arg('after')).split(',') : [], repeat: arg('repeat', 'none'),
    done: false, doneAt: null, created: now, updated: now, bestTime: arg('besttime', 'anytime'), why: String(arg('why', '')),
  };
  if (!arg('ai')) item.ai = now;   // values given are final; --ai leaves it for the AI to score
  if (arg('dry-run')) { console.log(JSON.stringify(item, null, 2)); return; }
  const auth = { Authorization: 'Bearer ' + key };
  for (let attempt = 0; attempt < 4; attempt++) {
    const g = await fetch(URL_BASE, { headers: auth });
    if (!g.ok) throw new Error('GET ' + g.status);
    const remote = await g.json();
    const data = remote.data || { items: [], deleted: {}, settingsUpdated: 0, weights: { wImp: 5, wUrg: 5, wEase: 2, wFit: 2 } };
    if (data.items.some(i => i.id === item.id)) { console.log('already exists:', item.id); return; }
    data.items.push(item);
    const p = await fetch(URL_BASE, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRev: remote.rev, data }) });
    if (p.status === 409) continue;
    if (!p.ok) throw new Error('PUT ' + p.status);
    console.log('added', item.id, item.when ? 'due ' + new Date(item.when).toISOString() : '(no deadline)');
    return;
  }
  throw new Error('gave up after revision clashes');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
