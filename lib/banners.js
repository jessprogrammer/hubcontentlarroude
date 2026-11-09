// Banners Home: campanhas da pasta "Banners Home" do Air (link público bfe8f9d0d), para a Marina aprovar ou reprovar.
// Servido por /api/approve?src=banners (dentro do approve porque o plano do Vercel aceita no máximo 12 funções).
// Aprovação LIVRE, sem senha (pedido da Jess). Aprovação é por campanha.
//   GET                          → { updated, items: campanhas pendentes }   (?refresh=1 relê o Air)
//   POST { action:'decide', id, st:'ok'|'no', msg, by }  → grava a decisão; reprovação avisa no Slack
// Pendente = sem decisão, OU arquivos novos no Air depois da decisão (o time subiu a correção).
// Slack: env SLACK_BANNERS_WEBHOOK (fluxo "Banner Home reprovado" do Slack Workflow Builder) avisa Jess e Monique
// na aprovação (pode subir) e na reprovação (com o motivo, obrigatório). Sem a env, só registra no hub.
import { pool, getJSON } from './util.js';
import { get, put } from './store.js';

const SC = 'bfe8f9d0d';
const ROOT = '5a3a3b3f-a215-4271-a65c-1b62c22eeadb';
const API = 'https://api.air.inc/shorturl/' + SC;
const CACHE = 'bh:cache', DEC = 'bh:dec';
const CUTOFF = '2026-10-05'; // campanhas (pastas) criadas antes disso já estavam no ar antes do menu existir
const TTL = 5 * 60e3;
const VERSION = 3; // muda quando o formato do cache muda
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

async function kids(id) {
  let out = [], cursor = null;
  do {
    const j = await getJSON(API + '/boards/' + id + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    out = out.concat(j.data || []);
    cursor = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
  } while (cursor);
  return out;
}
async function clips(id) {
  const j = await getJSON(API + '/clips/search', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filters: { board: { is: id }, type: { or: ['photo', 'video', 'animated'] } }, limit: 100 }) });
  return ((j.data && j.data.clips) || []).map(c => {
    const img = c.assets && c.assets.image ? String(c.assets.image).split('?')[0] : '';
    return { name: str(c.importedName || c.title || c.displayName, 160), w: c.width || 0, h: c.height || 0, type: c.type, upd: c.updatedAt || c.createdAt || '',
      img, video: c.type === 'video' && c.assets && c.assets.video ? String(c.assets.video) : '' };
  });
}
// "13.10 Bruno Frisoni" → data aproximada a partir do dia.mês do título
function titleDate(t, upd) {
  const m = String(t).match(/^(\d{1,2})\.(\d{1,2})/);
  return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') : (upd || '').slice(8, 10) + '/' + (upd || '').slice(5, 7);
}

async function build() {
  const camps = await kids(ROOT);
  const items = await pool(camps, 6, async b => {
    // pastas dentro de pastas (ex.: Hero / V1 - Esquentou por aqui): cada pasta com arquivos vira um bloco, com o caminho no título
    const groups = [];
    async function walk(g, path, depth) {
      const sub = depth < 4 ? await kids(g.id) : [];
      const files = await clips(g.id);
      if (files.length || !sub.length) groups.push({ id: g.id, title: str(path.join(' / '), 120), files });
      for (const c of sub) await walk(c, path.concat(c.title), depth + 1);
    }
    await walk(b, [], 0);
    const blocks = groups;
    // o Air às vezes tem o mesmo arquivo duas vezes: fica só o mais recente de cada nome
    for (const x of blocks) { const m = new Map(); for (const f of x.files) { const o = m.get(f.name); if (!o || f.upd > o.upd) m.set(f.name, f) } x.files = [...m.values()] }
    const all = blocks.flatMap(x => x.files);
    const upd = all.reduce((m, f) => (f.upd > m ? f.upd : m), '') || b.updatedAt || '';
    return { id: b.id, title: str(b.title, 120), date: titleDate(b.title, upd), upd, bupd: b.updatedAt || b.createdAt || upd, n: all.length,
      link: 'https://app.air.inc/a/' + SC + '/b/' + b.id, blocks: blocks.filter(x => x.files.length) };
  });
  return { v: VERSION, updated: new Date().toISOString(), items: items.filter(x => x.n) };
}

async function load(refresh) {
  const c = await get(CACHE);
  if (c && c.v === VERSION && !refresh && Date.now() - Date.parse(c.updated) < TTL) return c;
  try { const d = await build(); await put(CACHE, d); return d } catch (e) { if (c) return c; throw e }
}
// Cada banner é aprovado separadamente: se a campanha tem subpastas (ex.: Hero / V1, Collection / V2), cada subpasta vira
// um item próprio (id = id da subpasta). Campanha sem subpastas continua sendo um item só.
// Subpasta chamada "Aprovado(s)" é o time guardando o que já foi aprovado: fica de fora.
function expand(items) {
  const out = [];
  for (const c of items) {
    const blocks = c.blocks.filter(b => !/(^|\/\s*)aprovad/i.test(b.title));
    const sub = blocks.filter(b => b.title);
    if (!blocks.length) continue;
    if (!sub.length) {
      // campanha sem subpastas, mas com várias opções no nome do arquivo (…_DESKTOP_V9_… / …_MOBILE_V9_…):
      // cada opção (V1, V2…) vira um item próprio, juntando desktop e mobile da mesma opção
      const files = blocks.flatMap(b => b.files), G = new Map();
      for (const f of files) {
        const m = String(f.name).match(/(?:^|[_\s-])V(\d{1,2})(?=$|[_\s.-])/i);
        const k = m ? 'V' + (+m[1]) : '';
        if (!G.has(k)) G.set(k, []);
        G.get(k).push(f);
      }
      const keys = [...G.keys()].filter(Boolean);
      if (keys.length < 2) { out.push({ ...c, blocks, camp: c.id, campTitle: c.title }); continue }
      const ord = [...G.keys()].sort((x, y) => (x ? +x.slice(1) : 999) - (y ? +y.slice(1) : 999));
      for (const k of ord) {
        const fs = G.get(k).sort((x, y) => (x.w >= x.h ? 0 : 1) - (y.w >= y.h ? 0 : 1));
        const upd = fs.reduce((m, f) => (f.upd > m ? f.upd : m), '') || c.upd;
        const label = k ? 'Opção ' + k : 'outros arquivos';
        out.push({ ...c, id: c.id + ':' + (k || 'x'), camp: c.id, campTitle: c.title, title: c.title + ' · ' + label, unit: label,
          n: fs.length, upd, blocks: [{ id: c.id + ':' + (k || 'x'), title: '', files: fs }] });
      }
      continue;
    }
    for (const b of blocks) {
      const upd = b.files.reduce((m, f) => (f.upd > m ? f.upd : m), '') || c.upd;
      out.push({ ...c, id: b.id, camp: c.id, campTitle: c.title, title: c.title + ' · ' + (b.title || 'arquivos soltos'), unit: b.title || 'arquivos soltos',
        n: b.files.length, upd, blocks: [{ ...b, title: '' }], link: 'https://app.air.inc/a/' + SC + '/b/' + b.id });
    }
  }
  return out;
}
// data do título ("09.11 Esquenta Black" = 9/nov; "10.21 New Arrivals" = 21/out) → AAAA-MM-DD; '' se não tiver
function titleIso(t) {
  const m = String(t).match(/^(\d{1,2})\.(\d{1,2})/);
  if (!m) return '';
  let d = +m[1], mo = +m[2];
  if (mo > 12) { const x = d; d = mo; mo = x }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return '2026-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const pending = (it, D) => {
  // banner com data no título que já passou: não aparece mais (pedido da Jess)
  const ti = titleIso(it.campTitle || it.title);
  if (ti && ti < hojeBR()) return false;
  const d = D[it.id] || (it.camp && it.camp !== it.id ? D[it.camp] : null);
  if (d) return it.upd > d.ver;           // reavaliar só se o time subiu arquivo novo depois da decisão
  return String(it.bupd || it.upd).slice(0, 10) >= CUTOFF;
};

export default async function banners(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      const [C, D] = await Promise.all([load(q.refresh === '1'), get(DEC)]);
      const dec = D || {};
      const items = expand(C.items).filter(it => pending(it, dec)).map(it => ({ ...it, prev: dec[it.id] ? { st: dec[it.id].st, msg: dec[it.id].msg, at: dec[it.id].at, by: dec[it.id].by } : null }))
        .sort((a, b) => (b.campTitle === a.campTitle ? (a.title > b.title ? 1 : -1) : (b.bupd > a.bupd ? 1 : -1)));
      // histórico: as decisões gravadas (mais novas primeiro), para a aba mostrar o que já foi aprovado/reprovado
      const hist = Object.entries(dec).map(([id, d]) => ({ id, title: d.title || '', st: d.st, msg: d.msg || '', by: d.by || '', at: d.at || '', silent: !!d.silent }))
        .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 80);
      return res.status(200).json({ updated: C.updated, items, hist });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    if (body.action !== 'decide') return res.status(400).json({ error: 'ação' });
    const st = body.st === 'ok' ? 'ok' : body.st === 'no' ? 'no' : '';
    const msg = str(body.msg, 1500).trim(), by = str(body.by, 60).trim();
    if (!st) return res.status(400).json({ error: 'status' });
    if (st === 'no' && msg.length < 3) return res.status(400).json({ error: 'motivo da reprovação' });
    const C = await load(false);
    const it = expand(C.items).find(x => x.id === String(body.id));
    if (!it) return res.status(404).json({ error: 'campanha' });
    const D = (await get(DEC)) || {};
    // silent: "já tinha sido aprovado fora do hub" — só registra no histórico, sem avisar no Slack
    const silent = !!body.silent;
    D[it.id] = { st, msg, by, at: new Date().toISOString(), ver: it.upd, title: it.title, silent };
    await put(DEC, D);
    let slack = 'off';
    const hook = process.env.SLACK_BANNERS_WEBHOOK;
    if (hook && !silent) {
      try {
        const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ campanha: (st === 'ok' ? '🟢 APROVADO, pode subir: ' : '🔴 REPROVADO, precisa ajustar: ') + it.title, comentario: msg || (st === 'ok' ? 'Aprovado sem comentários' : ''), quem: by || 'Sem nome', link_air: it.link, link_hub: 'https://hub-contentlarroude.vercel.app/#banners' }) });
        slack = r.ok ? 'ok' : 'erro ' + r.status;
      } catch (e) { slack = 'erro' }
    }
    res.status(200).json({ ok: true, slack });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
