// /api/calendar — calendário de storytelling, mês a mês.
// GET  /api/calendar            → lista de meses
// GET  /api/calendar?m=2026-10  → o mês (do banco; se ainda não foi editado, a versão inicial em data/)
// POST /api/calendar  { password, action: 'check' | 'save' | 'create', month, doc }
// Para editar precisa da senha (env CAL_PASSWORD; se não existir, usa TEAM_PASSWORD).
import { get, put } from '../lib/store.js';
import oct2026 from '../data/cal-2026-10.js';
import socialCal, { insights } from '../lib/social-cal.js';

const SEEDS = { '2026-10': oct2026 };
const MN = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const FIELDS = oct2026.fields;
const okMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

async function months() {
  const saved = (await get('cal:months')) || [];
  return Array.from(new Set(Object.keys(SEEDS).concat(saved))).sort();
}
async function load(m) {
  const d = await get('cal:' + m);
  if (d) return d;
  if (SEEDS[m]) return { ...SEEDS[m], updated: null };
  return null;
}
// limpa o que vem do navegador: só texto, tamanhos limitados
function clean(doc, m) {
  const str = (v, n = 2000) => String(v == null ? '' : v).slice(0, n);
  const days = {};
  for (const [d, v] of Object.entries((doc && doc.days) || {})) {
    if (!d.startsWith(m) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const o = {}; let any = false;
    for (const f of FIELDS) { o[f.k] = str(v && v[f.k]); if (o[f.k].trim()) any = true }
    if (any) days[d] = o;
  }
  const notes = ((doc && doc.notes) || []).slice(0, 20).map(n => ({
    title: str(n.title, 200),
    cols: (n.cols || []).slice(0, 12).map(c => str(c, 200)),
    rows: (n.rows || []).slice(0, 200).map(r => (r || []).slice(0, 12).map(c => str(c)))
  }));
  const [y, mo] = m.split('-');
  return { month: m, title: str(doc && doc.title, 80) || MN[+mo - 1] + ' ' + y, fields: FIELDS, days, notes };
}

export default async function handler(req, res) {
  // calendário de Social (planilha), no mesmo endpoint
  if (req.query && req.query.src === 'social') return socialCal(req, res);
  if (req.query && req.query.src === 'insights') return insights(req, res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const m = req.query && req.query.m;
      if (!m) return res.status(200).json({ months: await months() });
      if (!okMonth(m)) return res.status(400).json({ error: 'mês inválido' });
      const d = await load(m);
      return d ? res.status(200).json(d) : res.status(404).json({ error: 'mês não encontrado' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    const pass = process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD;
    if (!pass || String(body.password || '') !== pass) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: 'senha' }) }
    if (body.action === 'check') return res.status(200).json({ ok: true });
    const m = body.month;
    if (!okMonth(m)) return res.status(400).json({ error: 'mês inválido' });
    if (body.action === 'create') {
      const exists = await load(m);
      if (exists) return res.status(200).json(exists);
      const prev = await load(body.copyNotesFrom || '');
      const doc = clean({ days: {}, notes: prev ? prev.notes.map(n => ({ ...n, rows: [] })) : [] }, m);
      doc.updated = new Date().toISOString();
      await put('cal:' + m, doc);
      await put('cal:months', Array.from(new Set(((await get('cal:months')) || []).concat(m))).sort());
      return res.status(200).json(doc);
    }
    if (body.action === 'save') {
      const doc = clean(body.doc, m);
      doc.updated = new Date().toISOString();
      await put('cal:' + m, doc);
      await put('cal:months', Array.from(new Set(((await get('cal:months')) || []).concat(m))).sort());
      return res.status(200).json(doc);
    }
    res.status(400).json({ error: 'ação' });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
