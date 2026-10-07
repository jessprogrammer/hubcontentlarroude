// Calendário de Social (abas de mês da planilha Social_Media_Calendar_2026), servido por /api/calendar?src=social.
// (fica dentro do /api/calendar porque o plano do Vercel aceita no máximo 12 funções)
import { get } from './store.js';

export default async function socialCal(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const doc = (await get('sheet:socialCal')) || { rows: [], updated: null };
    res.status(200).json({ updated: doc.updated, rows: doc.rows });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
