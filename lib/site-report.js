// Website: relatório de performance do site (lojas Shopify US e BR), servido por /api/products?src=site.
// (dentro do /api/products porque o plano do Vercel aceita no máximo 12 funções)
// Quem gera os números é o relatório de hora em hora do Claude (conector da Shopify): ele grava dois JSON
// na planilha "Hub – Relatório do site (não editar)" — A1 = agora (hoje por hora, totais, funil, top do dia),
// A2 = dia (últimos 30 dias e top 7 dias). O Apps Script (Site.gs) manda a planilha para o /api/ingest (chave "site").
// GET → { updated, agora, dia, img:{ productId: url } }
import { get } from './store.js';
import { catalog } from '../api/products.js';

const parse = c => { const s = String(c || '').replace(/^J\|/, ''); try { return JSON.parse(s) } catch (e) { return null } };

export default async function site(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const doc = await get('sheet:site');
    const rows = (doc && doc.rows) || [];
    const agora = parse(rows[0] && rows[0][0]), dia = parse(rows[1] && rows[1][0]);
    // fotos dos produtos do top (catálogo público de cada loja, pelo id do produto)
    const img = {};
    const ids = { US: new Set(), BR: new Set() };
    for (const [mk, k] of [['US', 'us'], ['BR', 'br']]) {
      for (const src of [agora && agora[k] && agora[k].top, dia && dia[k] && dia[k].top7]) (src || []).forEach(p => p && p[0] && ids[mk].add(String(p[0])));
    }
    for (const mk of ['US', 'BR']) {
      if (!ids[mk].size) continue;
      try {
        const D = await catalog(mk);
        for (const p of D.items || []) if (ids[mk].has(p.id)) img[p.id] = { img: p.img, url: p.url };
      } catch (e) {}
    }
    res.status(200).json({ updated: doc ? doc.updated : null, agora, dia, img });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
