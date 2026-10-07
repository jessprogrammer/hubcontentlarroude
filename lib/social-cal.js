// Calendário de Social (abas de mês da planilha Social_Media_Calendar_2026), servido por /api/calendar?src=social.
// (fica dentro do /api/calendar porque o plano do Vercel aceita no máximo 12 funções)
// A planilha é só lida (o Apps Script manda as abas de mês a cada 10 min). Sugestões feitas no hub ficam salvas no site.
// GET                                   → { updated, months, items (da planilha), sug (sugestões do hub), formats }
// POST { password, action: 'check' }                    → confere a senha (a mesma do Banco de copy)
// POST { password, action: 'save', item }               → cria ou edita uma sugestão
// POST { password, action: 'delete', id }               → apaga uma sugestão
import { get, put } from './store.js';

const KEY = 'social:sug';
const FORMATS = ['Stories', 'Feed', 'Reels'];
const MON = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const pad = n => String(n).padStart(2, '0');
const newId = () => Math.random().toString(36).slice(2, 12);

// "Oct. 2026" → { y: 2026, m: 10 }
function tabMonth(t) {
  const m = String(t || '').trim().match(/^([A-Za-zçÇ]+)\.?\s+(20\d\d)$/);
  if (!m) return null;
  const mo = MON[m[1].slice(0, 3).toLowerCase()];
  return mo ? { y: +m[2], m: mo } : null;
}
// links das células (coluna 27, mandada pelo script): só http(s)
function linkOf(r, c) {
  if (!r || !r[27]) return '';
  try { const u = String(JSON.parse(r[27])[c] || ''); return /^https?:\/\//.test(u) ? u.slice(0, 500) : '' } catch (e) { return '' }
}
const fmtOf = s => FORMATS.find(f => new RegExp(f, 'i').test(String(s || ''))) || '';

// Cada semana: linha "Date" (dd/mm nas colunas B–H), depois pares "📎 Request" + linha do formato (Stories/Feed/Reels)
export function parse(rows) {
  const byTab = {};
  for (const r of rows) (byTab[r[25]] = byTab[r[25]] || []).push(r);
  const map = new Map();
  const months = [];
  for (const [tab, rs] of Object.entries(byTab)) {
    const tm = tabMonth(tab);
    if (!tm) continue;
    months.push({ key: tm.y + '-' + pad(tm.m), title: tab });
    let dates = [], lastReq = null;
    rs.sort((a, b) => +a[26] - +b[26]);
    for (const r of rs) {
      const head = String(r[0] || '').trim();
      if (/^date$/i.test(head)) {
        dates = [1, 2, 3, 4, 5, 6, 7].map(c => {
          const d = String(r[c] || '').match(/(\d{1,2})\/(\d{1,2})/);
          if (!d) return '';
          let y = tm.y; const mo = +d[2];
          if (tm.m === 12 && mo === 1) y++; if (tm.m === 1 && mo === 12) y--;
          return y + '-' + pad(mo) + '-' + pad(+d[1]);
        });
        lastReq = null; continue;
      }
      if (/request/i.test(head)) { lastReq = r; continue }
      const fmt = fmtOf(head);
      if (!fmt || !dates.length) { lastReq = null; continue }
      for (let c = 1; c <= 7; c++) {
        const date = dates[c - 1];
        if (!date) continue;
        const req = str(lastReq && lastReq[c], 400).trim(), piece = str(r[c], 400).trim();
        const reqUrl = linkOf(lastReq, c), pieceUrl = linkOf(r, c);
        if (!req && !piece) continue;
        const k = date + '|' + fmt;
        const old = map.get(k);
        // a mesma data pode aparecer em duas abas (semana que vira o mês): fica a que tem mais informação
        if (!old || (req + piece).length > (old.req + old.piece).length) map.set(k, { id: 'p:' + k, date, fmt, req, piece, reqUrl, pieceUrl, tab });
      }
      lastReq = null;
    }
  }
  months.sort((a, b) => a.key.localeCompare(b.key));
  const items = [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || FORMATS.indexOf(a.fmt) - FORMATS.indexOf(b.fmt));
  return { months, items };
}

function cleanSug(it) {
  return {
    id: /^[a-z0-9]{6,24}$/.test(String(it.id || '')) ? it.id : newId(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')) ? it.date : '',
    fmt: FORMATS.includes(it.fmt) ? it.fmt : '',
    text: str(it.text, 600).trim(),
    notes: str(it.notes, 1000)
  };
}

export default async function socialCal(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const doc = (await get('sheet:socialCal')) || { rows: [], updated: null };
      const S = (await get(KEY)) || { items: [] };
      const { months, items } = parse(doc.rows || []);
      return res.status(200).json({ updated: doc.updated, months, items, sug: S.items, formats: FORMATS });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    const pass = process.env.COPY_PASSWORD || process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD;
    if (!pass || String(body.password || '') !== pass) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: 'senha' }) }
    if (body.action === 'check') return res.status(200).json({ ok: true });
    const S = (await get(KEY)) || { items: [] };
    const now = new Date().toISOString();
    if (body.action === 'save') {
      const it = cleanSug(body.item || {});
      if (!it.date || !it.text) return res.status(400).json({ error: 'data e texto' });
      const i = S.items.findIndex(x => x.id === it.id);
      if (i >= 0) S.items[i] = { ...S.items[i], ...it, edited: now };
      else { if (S.items.length >= 2000) return res.status(400).json({ error: 'limite' }); S.items.push({ ...it, created: now }) }
    } else if (body.action === 'delete') {
      S.items = S.items.filter(x => x.id !== String(body.id));
    } else return res.status(400).json({ error: 'ação' });
    S.updated = now;
    await put(KEY, S);
    res.status(200).json({ ok: true, sug: S.items });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
