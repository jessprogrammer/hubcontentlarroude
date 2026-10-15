// Fotos e vídeos: banco de criativos do Air por categoria (tags oficiais do time), com busca e troca de tag.
// Servido por /api/air?src=library (dentro do air porque o plano do Vercel aceita no máximo 12 funções).
// Usa a API oficial do Air: env AIR_API_KEY + AIR_WORKSPACE_ID (Vercel).
// Só material raw: tudo que está na pasta ADS do Air (peças prontas) fica de fora (EXCLUDE_BOARDS).
//   GET  ?src=library&warm=1                       → monta/atualiza a lista de exclusão (até ~45 s por chamada)
//   GET  ?src=library&meta=1                       → { cats }
//   GET  ?src=library&cat=<key|all|none>&q=&type=&from=&cur=   → { items, next }
//        um arquivo entra na categoria se tiver a tag no Air OU o termo no nome do arquivo
//        (sem diferenciar maiúscula/minúscula/hífen). "none" = sem tag oficial e sem termo no nome.
//   GET  ?src=library&open=<assetId>&v=<versionId> → redireciona para o arquivo no Air
//   POST ?src=library { action:'tags', password, id, v, add:[catKey], remove:[tagId] } → troca as tags no Air
//   POST ?src=library { action:'check', password }  → senha do time de conteúdo (a do Banco de copy)
import { get, put } from './store.js';
import { catalog } from '../api/products.js';

const A = 'https://api.air.inc/v1';
const H = () => ({ 'x-api-key': process.env.AIR_API_KEY || '', 'x-air-workspace-id': process.env.AIR_WORKSPACE_ID || '' });
const PASS = () => process.env.COPY_PASSWORD || process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD || '';
const TAGS_KEY = 'lib:tags:v1', TAGS_TTL = 6 * 3600e3;
// fica de fora: pasta ADS do Air (peças já trabalhadas). O banco é só de material raw.
const EXCLUDE_BOARDS = ['a7005d86-6f0a-4d61-8eaa-11a48a247047'];
const EX_KEY = 'lib:ex:v1', EX_FULL = 24 * 3600e3, EX_CHECK = 10 * 60e3;
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// nome oficial (como a Jess passou) + formas aceitas no nome do arquivo / em tags antigas
export const CATS = [
  { k: 'product-focused', n: 'Product-focused', a: ['productfocused'] },
  { k: 'product-details', n: 'Product details', a: ['productdetails', 'productdetail'] },
  { k: 'product-mix', n: 'Product Mix', a: ['productmix'] },
  { k: 'on-foot', n: 'On-foot', a: ['onfoot'] },
  { k: 'hand-held', n: 'Hand-held', a: ['handheld'] },
  { k: 'colorway', n: 'Colorway', a: ['colorway', 'colorways'] },
  { k: 'editorial', n: 'Editorial', a: ['editorial'] },
  { k: 'ugc', n: 'UGC', a: ['ugc'] },
  { k: 'voice-over', n: 'Voice Over', a: ['voiceover'] },
  { k: 'lifestyle', n: 'Lifestyle', a: ['lifestyle'] },
  { k: 'unboxing', n: 'Unboxing', a: ['unboxing'] },
  { k: 'pdp', n: 'PDP', a: ['pdp', 'pdpmodel'] },
  { k: 'abc', n: 'ABC', a: ['abc', 'abcs'] },
  { k: 'copy-only', n: 'Copy Only', a: ['copyonly'] },
  { k: '3d', n: '3D', a: ['3d'] },
  { k: 'factory', n: 'Factory', a: ['factory', 'factory3'] },
];
const BY_K = Object.fromEntries(CATS.map(c => [c.k, c]));
const ALIAS = new Map(); CATS.forEach(c => c.a.forEach(a => ALIAS.set(a, c.k)));
// tags com prefixo ("shot:on-foot") contam pela parte depois dos dois-pontos
const tagCat = name => ALIAS.get(norm(String(name || '').split(':').pop()));

async function air(path, opt = {}, tries = 4) {
  for (let k = 0; k < tries; k++) {
    const r = await fetch(A + path, { ...opt, headers: { ...H(), ...(opt.headers || {}) } });
    if (r.status === 204) return null;
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 1000 * (k + 1))); continue }
    let m = ''; try { m = (await r.json()).message || '' } catch (e) {}
    throw new Error('Air ' + r.status + (m ? ': ' + str(m, 160) : ''));
  }
  throw new Error('Air ocupado, tente de novo');
}

// tags do workspace que correspondem a cada categoria (o nome exato muda: "PRODUCT FOCUSED", "ABC'S"…)
async function tagIndex(refresh) {
  const c = await get(TAGS_KEY);
  if (c && !refresh && Date.now() - Date.parse(c.updated) < TAGS_TTL) return c;
  const byCat = {}, official = {};
  let cur = null, n = 0;
  do {
    const j = await air('/tags?limit=500' + (cur ? '&cursor=' + encodeURIComponent(cur) : ''));
    for (const t of j.data || []) {
      const k = tagCat(t.name);
      if (!k) continue;
      (byCat[k] = byCat[k] || []).push(t.name);
      if (t.name === BY_K[k].n) official[k] = t.id;
    }
    cur = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
  } while (cur && ++n < 80);
  const d = { updated: new Date().toISOString(), byCat, official };
  await put(TAGS_KEY, d);
  return d;
}


// ids (10 primeiros caracteres) de todos os arquivos dentro das pastas excluídas.
// A pasta ADS tem ~12 mil arquivos: a lista é montada aos poucos (continua de onde parou a cada visita)
// e depois só soma os arquivos novos. Refaz do zero 1x por dia, mantendo a lista antiga enquanto isso.
async function exclusion(budgetMs) {
  const t0 = Date.now();
  let E = (await get(EX_KEY)) || { ids: '', top: '', full: '', chk: 0, b: null };
  let dirty = false;
  if (!E.b && (!E.full || Date.now() - Date.parse(E.full) > EX_FULL)) { E.b = { i: 0, c: null, ids: '', top: '' }; dirty = true }
  const page = async (board, cur, limit) => {
    const sp = new URLSearchParams({ limit: String(limit), parentBoardId: board, includeNestedAssets: 'true' });
    if (cur) sp.set('cursor', cur);
    return air('/assets?' + sp.toString());
  };
  if (E.b) {
    while (Date.now() - t0 < budgetMs) {
      const board = EXCLUDE_BOARDS[E.b.i];
      if (!board) { E.ids = E.b.ids; E.top = E.b.top; E.full = new Date().toISOString(); E.chk = Date.now(); E.b = null; dirty = true; break }
      const j = await page(board, E.b.c, 500);
      for (const a of j.data || []) {
        E.b.ids += (E.b.ids ? ',' : '') + a.id.slice(0, 10);
        const u = a.coverVersion && a.coverVersion.updatedAt || '';
        if (u > E.b.top) E.b.top = u;
      }
      E.b.c = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
      if (!E.b.c) E.b.i++;
      dirty = true;
    }
  } else if (Date.now() - (E.chk || 0) > EX_CHECK) {
    // só os arquivos novos (a lista vem do mais recente para o mais antigo)
    const have = new Set(E.ids.split(','));
    for (const board of EXCLUDE_BOARDS) {
      let cur = null, n = 0, stop = false;
      do {
        const j = await page(board, cur, 100);
        for (const a of j.data || []) {
          const u = a.coverVersion && a.coverVersion.updatedAt || '';
          if (u && u <= E.top) { stop = true; break }
          const k = a.id.slice(0, 10);
          if (!have.has(k)) { have.add(k); E.ids += (E.ids ? ',' : '') + k }
        }
        cur = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
      } while (!stop && cur && ++n < 5);
    }
    E.top = new Date().toISOString(); E.chk = Date.now(); dirty = true;
  }
  if (dirty) await put(EX_KEY, E);
  const set = new Set(E.ids ? E.ids.split(',') : []);
  if (E.b && E.b.ids) for (const k of E.b.ids.split(',')) set.add(k);
  return { set, ready: !!E.full, building: !!E.b };
}

function catsOf(fileName, tags) {
  const out = new Set();
  for (const t of tags) { const k = tagCat(t); if (k) out.add(k) }
  const tok = String(fileName || '').split(/[_\s.()[\]{}+,;]+/).map(norm).filter(Boolean);
  for (let i = 0; i < tok.length; i++) {
    const k1 = ALIAS.get(tok[i]); if (k1) out.add(k1);
    if (i + 1 < tok.length) { const k2 = ALIAS.get(tok[i] + tok[i + 1]); if (k2) out.add(k2) }
  }
  return [...out];
}

function shape(a) {
  const v = a.coverVersion || {};
  const tags = (v.tags || []).map(t => ({ id: t.id, l: str(t.label || t.name, 80) }));
  const urls = v.urls || {};
  const th = urls.thumbnail ? String(urls.thumbnail).split('?')[0] : '';
  const isVid = v.type === 'video';
  return {
    id: a.id, v: v.id, n: str(v.fileName, 200), ext: str(v.ext, 10), t: isVid ? 'video' : 'photo',
    w: v.width || 0, h: v.height || 0, d: v.fileCreatedAt || v.createdAt || '', up: v.createdAt || '',
    th: th && /imgix\.net/.test(th) ? th + '?w=520&auto=format' : th,
    pv: isVid ? str(urls.preview, 400) : '',
    dur: isVid ? Math.round(v.duration || 0) : 0,
    tags, cats: catsOf(v.fileName, tags.map(t => t.l)),
  };
}

// nome do produto → SKUs base (os arquivos costumam ter o SKU no nome)
async function skusFor(q) {
  const nq = norm(q);
  if (nq.length < 3 || /\d{3}/.test(q)) return [];
  try {
    const D = await catalog('US');
    const hits = (D.items || []).filter(p => norm(p.t).includes(nq));
    const out = [];
    for (const p of hits) for (const s of p.sku || []) { const b = String(s).split('-')[0]; if (b && !out.includes(b)) out.push(b) }
    return out.slice(0, 4);
  } catch (e) { return [] }
}

const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = s => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString()) } catch (e) { return null } };

async function list(q) {
  const cat = q.cat === 'all' || q.cat === 'none' ? q.cat : BY_K[q.cat] ? q.cat : 'all';
  const term = str(q.q, 80).trim();
  const type = q.type === 'photo' || q.type === 'video' ? q.type : '';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? q.from : '';
  let st = q.cur ? dec(q.cur) : null;
  if (!st) {
    let streams = [];
    if (term) {
      streams = [term, ...(await skusFor(term))].map(s => ({ search: s }));
    } else if (cat === 'none' || cat === 'all') {
      streams = [{}];
    } else {
      const T = await tagIndex(false);
      streams = (T.byCat[cat] || []).map(t => ({ tag: t })).concat([{ search: BY_K[cat].n }]);
    }
    st = { s: streams.map(p => ({ p, c: null, done: false })) };
  }
  const EX = await exclusion(6000);
  const items = [], seen = new Set();
  const want = cat === 'none' ? 60 : 40;
  for (let round = 0; round < (cat === 'none' ? 5 : 2) && items.length < want; round++) {
    const live = st.s.filter(x => !x.done);
    if (!live.length) break;
    const pages = await Promise.all(live.map(async x => {
      const sp = new URLSearchParams({ limit: cat === 'none' ? '200' : '100' });
      if (x.p.tag) sp.append('tag', x.p.tag);
      if (x.p.search) sp.set('search', x.p.search);
      if (from) sp.set('createdAt[gte]', from + 'T00:00:00.000Z');
      if (x.c) sp.set('cursor', x.c);
      const j = await air('/assets?' + sp.toString());
      x.c = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
      x.done = !x.c;
      return j.data || [];
    }));
    for (const a of pages.flat()) {
      if (!a || !a.coverVersion || seen.has(a.id) || EX.set.has(a.id.slice(0, 10))) continue;
      const it = shape(a);
      if (type && it.t !== type) continue;
      if (cat === 'none' ? it.cats.length : cat !== 'all' && !it.cats.includes(cat)) continue;
      seen.add(a.id); items.push(it);
    }
  }
  items.sort((a, b) => (b.up > a.up ? 1 : -1));
  const more = st.s.some(x => !x.done);
  return { items, next: more ? enc(st) : null, partial: !EX.ready };
}

async function openLink(id, v) {
  try {
    const j = await air('/assets/' + encodeURIComponent(id) + '/boards?limit=1');
    const b = j.data && j.data[0];
    if (b) return 'https://app.air.inc/b/' + b.id + '/c/' + v;
  } catch (e) {}
  return 'https://app.air.inc/';
}

async function setTags(body) {
  const id = str(body.id, 40), v = str(body.v, 40);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(v)) throw new Error('arquivo');
  const add = (Array.isArray(body.add) ? body.add : []).filter(k => BY_K[k]).slice(0, 16);
  const remove = (Array.isArray(body.remove) ? body.remove : []).map(x => str(x, 40)).filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 40);
  const T = await tagIndex(false);
  let changedIndex = false;
  for (const k of add) {
    let tid = T.official[k];
    if (!tid) {
      // a tag oficial ainda não existe com esse nome exato: procura e, se não achar, cria
      const s = await air('/tags?limit=50&name=' + encodeURIComponent(BY_K[k].n));
      const hit = (s.data || []).find(t => t.name === BY_K[k].n);
      tid = hit ? hit.id : (await air('/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: BY_K[k].n }) })).id;
      T.official[k] = tid; (T.byCat[k] = T.byCat[k] || []).includes(BY_K[k].n) || T.byCat[k].push(BY_K[k].n); changedIndex = true;
    }
    if (remove.includes(tid)) continue;
    await air('/assets/' + id + '/versions/' + v + '/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tid }) });
  }
  for (const tid of remove) {
    try { await air('/assets/' + id + '/versions/' + v + '/tags/' + tid, { method: 'DELETE' }) } catch (e) { if (!/404/.test(e.message)) throw e }
  }
  if (changedIndex) await put(TAGS_KEY, T);
  // devolve o arquivo atualizado
  const j = await air('/assets/' + id);
  const a = j && (j.coverVersion ? j : j.data);
  return a && a.coverVersion ? shape(a) : null;
}

export default async function library(req, res) {
  try {
    if (!process.env.AIR_API_KEY || !process.env.AIR_WORKSPACE_ID) return res.status(503).json({ error: 'AIR_API_KEY / AIR_WORKSPACE_ID não configuradas no Vercel' });
    const q = req.query || {};
    if (req.method === 'GET') {
      if (q.open) { res.setHeader('Cache-Control', 'no-store'); res.writeHead(302, { Location: await openLink(str(q.open, 40), str(q.v, 40)) }); return res.end() }
      if (q.meta) { res.setHeader('Cache-Control', 's-maxage=3600'); return res.status(200).json({ cats: CATS.map(c => ({ k: c.k, n: c.n })) }) }
      if (q.warm) { const x = await exclusion(45000); res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ excluded: x.set.size, ready: x.ready, building: x.building }) }
      if (q.refresh === '1') await tagIndex(true);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json(await list(q));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    res.setHeader('Cache-Control', 'no-store');
    const ok = PASS() && String(body.password || '') === PASS();
    if (!ok) return res.status(401).json({ error: 'senha' });
    if (body.action === 'check') return res.status(200).json({ ok: true });
    if (body.action === 'tags') return res.status(200).json({ ok: true, item: await setTags(body) });
    return res.status(400).json({ error: 'ação' });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
