// /api/team — Daily tasks. Só devolve os dados com a senha certa (env TEAM_PASSWORD).
// Lê a aba LANÇAMENTOS que o Apps Script envia para o banco a cada 10 min.
import { cached } from '../lib/util.js';
import { get } from '../lib/store.js';

async function build() {
  const doc = await get('sheet:lancamentos');
  if (!doc) throw new Error('planilha ainda não enviada');
  const rows = doc.rows.slice(1);
  const agg = new Map();
  for (const r of rows) {
    const m = String(r[0] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    if (String(r[7] || '').trim() !== '1') continue; // aux: conta
    const q = parseFloat(String(r[5] || '').replace(/\./g, '').replace(',', '.'));
    if (!q) continue;
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const n = (r[2] || '').trim(), p = (r[3] || '').trim(), t = (r[4] || '').trim();
    const e = /^capta/i.test(String(r[8] || '').trim()) ? 'C' : 'E';
    const k = [d, n, p, t, e].join('|');
    agg.set(k, (agg.get(k) || 0) + q);
  }
  const team = [...agg].map(([k, q]) => [...k.split('|'), q]).sort((a, b) => a[0].localeCompare(b[0]));
  return { updated: doc.updated, team };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  const ok = process.env.TEAM_PASSWORD && body && String(body.password || '') === process.env.TEAM_PASSWORD;
  if (!ok) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: 'senha' }); }
  try { res.status(200).json(await cached('team', 5 * 60e3, build)); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
}
