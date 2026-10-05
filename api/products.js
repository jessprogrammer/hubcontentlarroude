// /api/products — catálogo da loja Shopify (US), para ligar copys a produtos.
// Usa o catálogo público da loja (www.larroude.com/products.json): não precisa de chave.
// GET /api/products?q=cyprus   → até 24 produtos que batem com nome, handle, tipo ou SKU
// Guardado no banco por 6 h.
import { get, put } from '../lib/store.js';

const STORES = { US: 'https://www.larroude.com' };
const FRESH_MS = 6 * 3600e3;

// "L481-CARI-5.0-BLAC-3185" → "L481-CARI-BLAC-3185" (tira o tamanho)
const baseSku = s => String(s || '').toUpperCase().replace(/-\d{1,2}(\.\d)?(?=-)/, '').trim();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function fetchCatalog(base) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    let j;
    try {
      const r = await fetch(base + '/products.json?limit=250&page=' + page, { signal: ctl.signal, headers: { 'user-agent': 'LarroudeContentHub/1.0', accept: 'application/json' } });
      if (!r.ok) throw new Error('Shopify ' + r.status);
      j = await r.json();
    } finally { clearTimeout(t) }
    const ps = j.products || [];
    for (const p of ps) {
      const img = (p.images && p.images[0] && p.images[0].src) || '';
      out.push({
        id: String(p.id), t: p.title, h: p.handle, ty: p.product_type || '',
        sku: [...new Set((p.variants || []).map(v => baseSku(v.sku)).filter(Boolean))].slice(0, 6),
        img: img ? img + (img.includes('?') ? '&' : '?') + 'width=160' : '',
        url: base + '/products/' + p.handle
      });
    }
    if (ps.length < 250) break;
  }
  return out;
}

export async function catalog(mk) {
  const key = 'shop:' + mk;
  let D = null;
  try { D = await get(key) } catch (e) {}
  if (!D || Date.now() - Date.parse(D.updated) > FRESH_MS) {
    try {
      const items = await fetchCatalog(STORES[mk]);
      if (items.length) { D = { updated: new Date().toISOString(), items }; try { await put(key, D) } catch (e) {} }
    } catch (e) { if (!D) throw e }
  }
  return D;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const mk = STORES[(req.query && req.query.mk) || 'US'] ? ((req.query && req.query.mk) || 'US') : 'US';
    const D = await catalog(mk);
    const q = norm((req.query && req.query.q) || '').trim();
    if (!q) return res.status(200).json({ updated: D.updated, total: D.items.length, items: [] });
    const words = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const p of D.items) {
      const hay = norm(p.t + ' ' + p.h + ' ' + p.ty + ' ' + p.id + ' ' + p.sku.join(' '));
      if (!words.every(w => hay.includes(w))) continue;
      const tt = norm(p.t);
      const s = (tt.startsWith(q) ? 3 : 0) + (tt.includes(q) ? 2 : 0) + (p.sku.some(k => norm(k).includes(q)) ? 2 : 0);
      scored.push([s, p]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].t.localeCompare(b[1].t));
    res.status(200).json({ updated: D.updated, total: D.items.length, items: scored.slice(0, 24).map(x => x[1]) });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
