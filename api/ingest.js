// /api/ingest — recebe as planilhas enviadas pelo Apps Script da Jess (a cada 10 min).
// Sem senha: o script manda o token de identidade do Google, e aqui conferimos que é um e-mail autorizado.
import config from '../config.js';
import { put } from '../lib/store.js';

async function whoIs(idToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return null;
  const t = await r.json();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) return null;
  if (String(t.email_verified) !== 'true') return null;
  return String(t.email || '').toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const email = auth ? await whoIs(auth) : null;
  if (!email || !config.ingestEmails.map(e => e.toLowerCase()).includes(email)) return res.status(401).json({ error: 'não autorizado' });
  const saved = [];
  for (const key of ['criativos', 'criativosBR', 'lancamentos', 'socialCal', 'socialInsights']) {
    if (Array.isArray(body[key])) { await put('sheet:' + key, { updated: new Date().toISOString(), by: email, rows: body[key], ...(key === 'socialInsights' && body.socialInsightsFile ? { file: String(body.socialInsightsFile).slice(0, 200) } : {}) }); saved.push(key + ':' + body[key].length) }
  }
  res.status(200).json({ ok: true, saved });
}
