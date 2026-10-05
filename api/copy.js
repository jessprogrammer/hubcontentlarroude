// /api/copy — banco de copy (frases reutilizáveis), por mercado. Por enquanto: US.
// GET  /api/copy?mk=US                → { items, updated }
// POST /api/copy { password, action: 'check' | 'save' | 'delete', mk, item | id }
// Para editar precisa da senha (env CAL_PASSWORD; se não existir, usa TEAM_PASSWORD) — a mesma do Calendário.
import { get, put } from '../lib/store.js';

const MKS = ['US', 'BR'];
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function clean(it) {
  const prods = (Array.isArray(it.products) ? it.products : []).slice(0, 30).map(p => ({
    id: str(p.id, 30), t: str(p.t, 160), h: str(p.h, 160), sku: (Array.isArray(p.sku) ? p.sku : []).slice(0, 6).map(s => str(s, 40)),
    img: /^https:\/\/(cdn\.shopify\.com|www\.larroude\.com)\//.test(String(p.img || '')) ? str(p.img, 400) : '', url: /^https:\/\/www\.larroude\.com\//.test(String(p.url || '')) ? str(p.url, 300) : ''
  })).filter(p => p.id && p.t);
  return {
    id: /^[a-z0-9]{6,24}$/.test(String(it.id || '')) ? it.id : Math.random().toString(36).slice(2, 12),
    type: str(it.type, 60).trim(),
    text: str(it.text, 4000),
    tags: (Array.isArray(it.tags) ? it.tags : String(it.tags || '').split(',')).map(s => str(s, 40).trim()).filter(Boolean).slice(0, 12),
    notes: str(it.notes, 1000),
    products: prods
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      const mk = MKS.includes(q.mk) ? q.mk : 'US';
      const D = (await get('copy:' + mk)) || { items: [], updated: null };
      return res.status(200).json({ mk, ...D });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    const pass = process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD;
    if (!pass || String(body.password || '') !== pass) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: 'senha' }) }
    if (body.action === 'check') return res.status(200).json({ ok: true });
    const mk = MKS.includes(body.mk) ? body.mk : 'US';
    const key = 'copy:' + mk;
    const D = (await get(key)) || { items: [] };
    const now = new Date().toISOString();
    if (body.action === 'save') {
      const it = clean(body.item || {});
      if (!it.text.trim()) return res.status(400).json({ error: 'copy vazia' });
      const i = D.items.findIndex(x => x.id === it.id);
      if (i >= 0) D.items[i] = { ...D.items[i], ...it, edited: now };
      else { if (D.items.length >= 3000) return res.status(400).json({ error: 'limite' }); D.items.unshift({ ...it, created: now }) }
      D.updated = now;
      await put(key, D);
      return res.status(200).json({ mk, ...D });
    }
    if (body.action === 'delete') {
      D.items = D.items.filter(x => x.id !== String(body.id || ''));
      D.updated = now;
      await put(key, D);
      return res.status(200).json({ mk, ...D });
    }
    res.status(400).json({ error: 'ação' });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
