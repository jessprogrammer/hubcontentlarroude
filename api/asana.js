// /api/asana — tarefas abertas do board [MKT] Content Team / Marketing, para o painel "Entrega semanal".
// Precisa da variável ASANA_TOKEN no Vercel (Personal Access Token do Asana).
// Guarda o resultado por 60 s no banco, para o site abrir rápido e o Asana não ser chamado a cada visita.
import { get, put } from '../lib/store.js';

const API = 'https://app.asana.com/api/1.0';
const PROJECT = process.env.ASANA_PROJECT || '1203331193070474';
const KEY = 'asana:board';
const FRESH_MS = 60e3;
const FIELDS = 'name,assignee.name,due_on,start_on,permalink_url,modified_at,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value';
const DONE_STATUS = /^(entregue|delivered|aprovado|approved)$/i;

function token() {
  let v = String(process.env.ASANA_TOKEN || process.env.ASANA_ACCESS_TOKEN || '').trim();
  v = v.replace(/^[A-Z_]+\s*=\s*/, '').replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  return v;
}
// nunca devolve o token (nem pedaços dele) em mensagens de erro
const redact = s => String(s || '').replace(/[A-Za-z0-9_:\/-]{24,}/g, '[…]');

async function asana(path) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token(), Accept: 'application/json' }, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Asana ' + r.status + ' ' + redact(((j.errors || [])[0] || {}).message || '').slice(0, 160));
    return j;
  } finally { clearTimeout(t) }
}

async function allTasks() {
  let out = [], offset = '', n = 0;
  do {
    const j = await asana('/projects/' + PROJECT + '/tasks?completed_since=now&limit=100&opt_fields=' + FIELDS + (offset ? '&offset=' + offset : ''));
    out = out.concat(j.data || []);
    offset = j.next_page && j.next_page.offset;
  } while (offset && ++n < 30);
  return out;
}

const cf = (t, re) => { const f = (t.custom_fields || []).find(c => re.test(String(c.name || '').trim())); return f && f.display_value ? String(f.display_value).trim() : '' };
const clean = s => String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
// "🐆 DUDA TO DO LIST 🐆" → "Duda"; "BRUNA P. TO DO LIST" → "Bruna P."
function listOwner(sec) {
  const m = clean(sec).match(/^(.+?)\s+TO DO LIST$/i);
  if (!m) return '';
  return m[1].toLowerCase().replace(/(^|\s)\p{L}/gu, c => c.toUpperCase());
}

export function build(raw) {
  const tasks = [];
  for (const t of raw) {
    const mem = (t.memberships || []).find(m => m.project && m.project.gid === PROJECT);
    const sec = (mem && mem.section && mem.section.name || '').trim();
    if (/^done$/i.test(sec)) continue;
    const st = cf(t, /^status$/i);
    if (DONE_STATUS.test(st)) continue;
    tasks.push({ id: t.gid, n: String(t.name || '').trim() || '(sem título)', a: t.assignee && t.assignee.name || '', sec, lo: listOwner(sec),
      due: t.due_on || '', start: t.start_on || '', st, pri: cf(t, /^(priority|prioridade)$/i), cat: cf(t, /^category$/i), ctry: cf(t, /^country$/i),
      url: t.permalink_url || ('https://app.asana.com/0/' + PROJECT + '/' + t.gid), mod: t.modified_at || '' });
  }
  // a lista "MARI TO DO LIST" pertence a quem mais aparece como responsável nela
  const votes = {};
  for (const t of tasks) if (t.lo && t.a) { const v = votes[t.lo] = votes[t.lo] || {}; v[t.a] = (v[t.a] || 0) + 1 }
  const listTo = {};
  for (const [lo, v] of Object.entries(votes)) listTo[lo] = Object.entries(v).sort((p, q) => q[1] - p[1])[0][0];
  // nome curto: primeiro nome; se dois têm o mesmo, primeiro + inicial do segundo
  const full = new Set(tasks.map(t => t.a).filter(Boolean));
  const first = {}; for (const f of full) { const k = f.split(' ')[0]; first[k] = (first[k] || 0) + 1 }
  const short = f => { const p = f.split(' '); return first[p[0]] > 1 && p[1] ? p[0] + ' ' + p[1][0] + '.' : p[0] };
  const shortOfList = {}; for (const [lo, f] of Object.entries(listTo)) shortOfList[lo] = short(f);
  for (const t of tasks) {
    if (t.a) { t.who = short(t.a); t.by = 'a' }
    else if (t.lo) { t.who = shortOfList[t.lo] || t.lo; t.by = 'l' }
    else { t.who = ''; t.by = '' }
    delete t.lo;
  }
  return { updated: new Date().toISOString(), project: PROJECT, tasks };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!token()) return res.status(503).json({ error: 'ASANA_TOKEN não configurado no Vercel' });
    let D = null;
    try { D = await get(KEY) } catch (e) {}
    if (!D || Date.now() - Date.parse(D.updated) > FRESH_MS || (req.query && req.query.fresh === '1' && Date.now() - Date.parse(D.updated) > 10e3)) {
      try {
        D = build(await allTasks());
        try { await put(KEY, D) } catch (e) {}
      } catch (e) {
        if (!D) throw e;
        D.stale = true; // Asana fora do ar: mostra o último resultado guardado
      }
    }
    res.status(200).json(D);
  } catch (e) { res.status(502).json({ error: redact(e.message || e) }) }
}
