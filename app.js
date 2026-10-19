'use strict';

/* ---------- pure logic (also used by tests) ---------- */

const DEFAULTS = { wImp: 5, wUrg: 5, wEase: 2, gKey: '', gModel: 'gemini-2.5-flash' };
const HOUR = 3600e3, DAY = 24 * HOUR;

function urgency(when, now) {
  if (!when) return 0.12;
  const h = (when - now) / HOUR;
  if (h <= 0) return 1;
  return Math.max(0.1, 1 / (1 + Math.pow(h / 48, 0.8)));
}

// Returns {score 0..1, tier 'now'|'next'|'later', overdue, parts}
function rank(item, now, w) {
  const imp = (item.importance - 1) / 4;
  const ease = (item.ease - 1) / 4;
  const urg = urgency(item.when, now);
  const sum = (w.wImp + w.wUrg + w.wEase) || 1;
  const score = (w.wImp * imp + w.wUrg * urg + w.wEase * ease) / sum;
  const overdue = !!item.when && item.when < now;
  const soon = !!item.when && item.when - now < DAY;
  let tier = score >= 0.62 ? 'now' : score >= 0.4 ? 'next' : 'later';
  if (overdue || (soon && item.importance >= 3)) tier = 'now';
  return { score, tier, overdue, parts: { imp, urg, ease } };
}

function nextOccurrence(when, rep, now) {
  const d = new Date(when || now);
  do {
    if (rep === 'daily') d.setDate(d.getDate() + 1);
    else if (rep === 'weekly') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
  } while (d.getTime() <= now);
  return d.getTime();
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const EVENT_WORDS = /\b(meeting|appointment|dentist|doctor|call|lunch|dinner|interview|class|lecture|party|flight|concert|session)\b/i;

// "dentist fri 3pm" -> {title:'dentist', when:ms|null, hasTime:bool}
function parseQuick(text, nowMs) {
  const now = new Date(nowMs);
  let t = ' ' + text + ' ';
  let date = null, hh = null, mm = 0;
  const cut = re => { const m = t.match(re); if (m) t = t.replace(re, ' '); return m; };
  const day0 = () => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
  let m;
  if ((m = cut(/\bin\s+(\d+)\s*(min|mins|minutes|h|hr|hrs|hours|d|days|w|weeks)\b/i))) {
    const n = +m[1], u = m[2].toLowerCase()[0];
    const ms = u === 'm' ? n * 60e3 : u === 'h' ? n * HOUR : u === 'd' ? n * DAY : n * 7 * DAY;
    return { title: t.replace(/\s+/g, ' ').trim(), when: nowMs + ms, hasTime: u === 'm' || u === 'h' };
  }
  if ((m = cut(/\b(today|tonight)\b/i))) { date = day0(); if (/tonight/i.test(m[1])) hh = 20; }
  else if ((m = cut(/\b(tomorrow|tmrw|tmr)\b/i))) { date = day0(); date.setDate(date.getDate() + 1); }
  else if ((m = cut(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/i))) {
    const idx = WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3));
    date = day0();
    let add = (idx - date.getDay() + 7) % 7;
    if (add === 0) add = 7;
    date.setDate(date.getDate() + add);
  }
  if ((m = cut(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    hh = +m[1] % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0); mm = +(m[2] || 0);
  } else if ((m = cut(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) {
    hh = +m[1]; mm = +m[2];
  }
  const title = t.replace(/\s+/g, ' ').trim();
  if (!date && hh === null) return { title: text.trim(), when: null, hasTime: false };
  if (!date) { date = day0(); if (hh * 60 + mm <= now.getHours() * 60 + now.getMinutes()) date.setDate(date.getDate() + 1); }
  const hasTime = hh !== null;
  if (!hasTime) hh = EVENT_WORDS.test(title) ? 9 : 17;
  date.setHours(hh, mm, 0, 0);
  return { title: title || text.trim(), when: date.getTime(), hasTime };
}

if (typeof module !== 'undefined') module.exports = { urgency, rank, parseQuick, nextOccurrence, DEFAULTS };

/* ---------- app (browser only) ---------- */
if (typeof document !== 'undefined') (() => {
  const $ = s => document.querySelector(s);
  const KEY = 'focusqueue.v1';
  let db = load();
  let view = 'queue';
  let editing = null; // item being edited (copy)

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.items)) return { settings: { ...DEFAULTS, ...d.settings }, items: d.items };
    } catch (e) { /* fall through */ }
    return { settings: { ...DEFAULTS }, items: [] };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Could not save (storage full or blocked)'); } }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3000);
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function newItem(p) {
    return { id: uid(), title: '', type: 'task', when: null, importance: 3, ease: 3, minutes: null, notes: '',
      steps: [], repeat: 'none', done: false, doneAt: null, created: Date.now(), ...p };
  }

  function fmtWhen(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const dayDiff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const label = dayDiff === 0 ? 'Today' : dayDiff === 1 ? 'Tomorrow' : dayDiff === -1 ? 'Yesterday'
      : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return label + (d.getHours() || d.getMinutes() ? ', ' + time : '');
  }
  function until(ms, now) {
    const h = (ms - now) / HOUR, a = Math.abs(h);
    const s = a < 1 ? Math.round(a * 60) + ' min' : a < 48 ? Math.round(a) + ' h' : Math.round(a / 24) + ' d';
    return h < 0 ? s + ' overdue' : 'in ' + s;
  }

  /* ----- rendering ----- */
  function card(item, now, r) {
    const cls = item.type === 'event' ? 'event' : r ? r.tier : 'later';
    const chips = [];
    if (item.when) chips.push(`<span class="chip ${r && r.overdue ? 'over' : ''}">${esc(fmtWhen(item.when))} · ${until(item.when, now)}</span>`);
    if (item.type !== 'event') chips.push(`<span class="chip">★ ${item.importance}</span><span class="chip">ease ${item.ease}</span>`);
    if (item.minutes) chips.push(`<span class="chip">${item.minutes} min</span>`);
    if (item.repeat !== 'none') chips.push(`<span class="chip">↻ ${item.repeat}</span>`);
    if (item.type === 'habit') chips.push('<span class="chip">habit</span>');
    const stepsDone = item.steps.filter(s => s.done).length;
    if (item.steps.length) chips.push(`<span class="chip">${stepsDone}/${item.steps.length} steps</span>`);
    return `<div class="card ${cls} ${item.done ? 'isdone' : ''}" data-id="${item.id}">
      <input class="chk" type="checkbox" ${item.done ? 'checked' : ''} aria-label="Done: ${esc(item.title)}">
      <div class="body" tabindex="0" role="button"><div class="title">${esc(item.title)}</div><div class="chips">${chips.join('')}</div></div></div>`;
  }

  function renderQueue() {
    const now = Date.now(), w = db.settings;
    const open = db.items.filter(i => !i.done);
    const tasks = open.filter(i => i.type !== 'event')
      .map(i => ({ i, r: rank(i, now, w) })).sort((a, b) => b.r.score - a.r.score);
    const events = open.filter(i => i.type === 'event' && i.when && i.when > now - HOUR && i.when < now + 2 * DAY)
      .sort((a, b) => a.when - b.when);
    const labels = { now: 'Do now', next: 'Up next', later: 'Later' };
    let html = '';
    if (events.length) html += '<div class="group">Coming up</div>' + events.map(e => card(e, now, null)).join('');
    for (const tier of ['now', 'next', 'later']) {
      const g = tasks.filter(x => x.r.tier === tier);
      if (g.length) html += `<div class="group">${labels[tier]}</div>` + g.map(x => card(x.i, now, x.r)).join('');
    }
    $('#view-queue').innerHTML = html || '<div class="empty">Nothing to do. Add something above.</div>';
  }

  function renderAgenda() {
    const now = Date.now();
    const list = db.items.filter(i => !i.done && i.when).sort((a, b) => a.when - b.when);
    const byDay = new Map();
    for (const i of list) {
      const k = new Date(i.when).toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(i);
    }
    let html = '';
    for (const [k, arr] of byDay) {
      html += `<div class="group">${esc(fmtWhen(new Date(k).getTime()).replace(/,.*$/, '') || k)}</div>`;
      html += arr.map(i => card(i, now, i.type === 'event' ? null : rank(i, now, db.settings))).join('');
    }
    const undated = db.items.filter(i => !i.done && !i.when).length;
    if (undated) html += `<p class="muted">${undated} item${undated > 1 ? 's' : ''} without a date are only in the Queue.</p>`;
    $('#view-agenda').innerHTML = html || '<div class="empty">No dated items.</div>';
  }

  function renderDone() {
    const now = Date.now();
    const list = db.items.filter(i => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 100);
    $('#view-done').innerHTML = list.map(i => card(i, now, null)).join('') || '<div class="empty">Nothing completed yet.</div>';
  }

  function renderSettings() {
    const s = db.settings;
    for (const [id, k] of [['wImp', 'wImp'], ['wUrg', 'wUrg'], ['wEase', 'wEase']]) {
      const el = $('#' + id); el.value = s[k]; el.nextElementSibling.textContent = s[k];
    }
    $('#gKey').value = s.gKey; $('#gModel').value = s.gModel;
  }

  function render() {
    for (const v of ['queue', 'agenda', 'done', 'settings']) $('#view-' + v).hidden = v !== view;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    $('#quickAdd').hidden = view === 'settings';
    ({ queue: renderQueue, agenda: renderAgenda, done: renderDone, settings: renderSettings })[view]();
  }

  /* ----- actions ----- */
  function toggleDone(id) {
    const it = db.items.find(x => x.id === id); if (!it) return;
    const now = Date.now();
    if (!it.done && it.repeat !== 'none') {
      // keep a record, then roll the live item to its next date
      db.items.push({ ...it, id: uid(), done: true, doneAt: now, repeat: 'none' });
      it.when = nextOccurrence(it.when, it.repeat, now);
      it.steps.forEach(s => { s.done = false; });
      toast('Done. Next: ' + fmtWhen(it.when));
    } else {
      it.done = !it.done; it.doneAt = it.done ? now : null;
    }
    save(); render();
  }

  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3);
    return d.toISOString().slice(0, 16);
  }

  function openEditor(item, isNew) {
    editing = JSON.parse(JSON.stringify(item)); editing._new = !!isNew;
    $('#edHead').textContent = isNew ? 'New item' : 'Edit';
    $('#edTitle').value = item.title; $('#edType').value = item.type; $('#edRep').value = item.repeat;
    $('#edWhen').value = toLocalInput(item.when);
    $('#edImp').value = item.importance; $('#edEase').value = item.ease;
    $('#edMin').value = item.minutes || ''; $('#edNotes').value = item.notes;
    $('#edDelete').hidden = !!isNew; $('#edMsg').textContent = '';
    syncEditorType(); renderSteps();
    $('#editor').showModal();
  }
  function syncEditorType() {
    const ev = $('#edType').value === 'event';
    $('#edWhenLbl').textContent = ev ? 'Starts' : 'Deadline';
    $('#edScores').hidden = ev;
    $('#edAi').hidden = ev || !db.settings.gKey; $('#edBreak').hidden = ev || !db.settings.gKey;
  }
  function renderSteps() {
    $('#edSteps').innerHTML = editing.steps.length
      ? '<ul class="steps">' + editing.steps.map((s, i) =>
        `<li class="${s.done ? 'd' : ''}"><input type="checkbox" data-i="${i}" ${s.done ? 'checked' : ''}><span>${esc(s.text)}</span></li>`).join('') + '</ul>'
      : '';
  }
  function readEditor() {
    editing.title = $('#edTitle').value.trim();
    editing.type = $('#edType').value; editing.repeat = $('#edRep').value;
    editing.when = $('#edWhen').value ? new Date($('#edWhen').value).getTime() : null;
    editing.importance = +$('#edImp').value; editing.ease = +$('#edEase').value;
    editing.minutes = $('#edMin').value ? +$('#edMin').value : null;
    editing.notes = $('#edNotes').value;
  }

  /* ----- Gemini ----- */
  async function gemini(prompt, schema) {
    const { gKey, gModel } = db.settings;
    if (!gKey) throw new Error('Add a Gemini key in Settings first.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gModel || DEFAULTS.gModel)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(res.status === 429 ? 'Free limit reached, try again in a minute.' : `Gemini error ${res.status}. ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error('Gemini returned nothing. Try rephrasing.');
    return JSON.parse(txt);
  }
  async function aiRun(btn, fn) {
    btn.disabled = true; $('#edMsg').textContent = 'Thinking…';
    try { await fn(); $('#edMsg').textContent = ''; }
    catch (e) { $('#edMsg').textContent = e.message; }
    finally { btn.disabled = false; }
  }

  /* ----- wiring ----- */
  for (const sel of ['#edImp', '#edEase']) {
    const labels = sel === '#edImp' ? ['1 minor', '2', '3 normal', '4', '5 critical'] : ['1 hard', '2', '3 medium', '4', '5 quick win'];
    $(sel).innerHTML = labels.map((l, i) => `<option value="${i + 1}">${l}</option>`).join('');
  }

  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { view = b.dataset.view; render(); } });

  $('#quickAdd').addEventListener('submit', e => {
    e.preventDefault();
    const raw = $('#qaTitle').value.trim(); if (!raw) return;
    const p = parseQuick(raw, Date.now());
    const type = p.when && EVENT_WORDS.test(p.title) ? 'event' : 'task';
    db.items.push(newItem({ title: p.title, when: p.when, type }));
    save(); $('#qaTitle').value = ''; render();
    toast(p.when ? `Added for ${fmtWhen(p.when)}` : 'Added');
  });
  $('#qaMore').addEventListener('click', () => openEditor(newItem({ title: $('#qaTitle').value.trim() }), true));

  document.addEventListener('click', e => {
    const c = e.target.closest('.card'); if (!c) return;
    if (e.target.classList.contains('chk')) return toggleDone(c.dataset.id);
    if (e.target.closest('.body')) openEditor(db.items.find(x => x.id === c.dataset.id));
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card .body')) { e.preventDefault(); e.target.click(); }
  });

  $('#edType').addEventListener('change', syncEditorType);
  $('#edSteps').addEventListener('change', e => {
    if (e.target.dataset.i) { editing.steps[+e.target.dataset.i].done = e.target.checked; renderSteps(); }
  });
  $('#edCancel').addEventListener('click', () => $('#editor').close());
  $('#edDelete').addEventListener('click', () => {
    db.items = db.items.filter(x => x.id !== editing.id); save(); $('#editor').close(); render(); toast('Deleted');
  });
  $('#editForm').addEventListener('submit', () => {
    readEditor();
    if (!editing.title) return;
    const { _new, ...clean } = editing;
    if (_new) db.items.push(clean);
    else db.items = db.items.map(x => x.id === clean.id ? clean : x);
    save(); render();
  });

  $('#edAi').addEventListener('click', e => aiRun(e.currentTarget, async () => {
    readEditor();
    const r = await gemini(
      `You help someone triage tasks. Today is ${new Date().toDateString()}.\nTask: "${editing.title}"\nNotes: "${editing.notes}"\n` +
      'Rate importance 1 (minor) to 5 (critical consequences if missed). Rate ease 1 (very hard/long) to 5 (quick win). Estimate minutes of effort.',
      { type: 'OBJECT', properties: { importance: { type: 'INTEGER' }, ease: { type: 'INTEGER' }, minutes: { type: 'INTEGER' } }, required: ['importance', 'ease', 'minutes'] });
    const clamp = n => Math.min(5, Math.max(1, Math.round(n) || 3));
    $('#edImp').value = clamp(r.importance); $('#edEase').value = clamp(r.ease);
    if (r.minutes > 0) $('#edMin').value = Math.round(r.minutes);
  }));
  $('#edBreak').addEventListener('click', e => aiRun(e.currentTarget, async () => {
    readEditor();
    const r = await gemini(
      `Break this task into 3 to 8 small, concrete, physical first-actions, in order. Task: "${editing.title}". Notes: "${editing.notes}". Each step under 12 words.`,
      { type: 'OBJECT', properties: { steps: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['steps'] });
    editing.steps = (r.steps || []).slice(0, 12).map(text => ({ text: String(text), done: false }));
    renderSteps();
  }));

  for (const [id, k] of [['wImp', 'wImp'], ['wUrg', 'wUrg'], ['wEase', 'wEase']]) {
    $('#' + id).addEventListener('input', e => { db.settings[k] = +e.target.value; e.target.nextElementSibling.textContent = e.target.value; save(); });
  }
  $('#gKey').addEventListener('change', e => { db.settings.gKey = e.target.value.trim(); save(); });
  $('#gModel').addEventListener('change', e => { db.settings.gModel = e.target.value.trim() || DEFAULTS.gModel; save(); });

  $('#exportBtn').addEventListener('click', () => {
    const { gKey, ...settings } = db.settings; // never export the API key
    const blob = new Blob([JSON.stringify({ settings, items: db.items }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'focus-queue-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.items)) throw new Error('bad file');
      const have = new Set(db.items.map(i => i.id));
      const add = d.items.filter(i => i && i.id && i.title && !have.has(i.id));
      db.items.push(...add.map(i => newItem(i))); save(); render(); toast(`Imported ${add.length} item(s)`);
    } catch (err) { toast('That file could not be read'); }
    e.target.value = '';
  });

  setInterval(() => { if (!$('#editor').open && view !== 'settings') render(); }, 60e3);
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
