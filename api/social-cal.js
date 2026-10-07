// /api/social-cal — calendário de Social (abas de mês da planilha Social_Media_Calendar_2026), enviado pelo Apps Script.
// GET ?raw=1 → linhas como vieram da planilha (para conferir o formato)
import { get } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const doc = (await get('sheet:socialCal')) || { rows: [], updated: null };
    res.status(200).json({ updated: doc.updated, rows: doc.rows });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
