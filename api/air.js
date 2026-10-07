// /api/air — criativos entregues, lidos ao vivo das pastas mensais do Air
// + tipo/status da planilha "US Request - Meta" (CSV publicado na web, env CRIATIVOS_CSV_URL)
import config from '../config.js';
import overrides from '../overrides.js';
import { pool, getJSON, cached, WD, iso, mondayOf } from '../lib/util.js';
import { get, put } from '../lib/store.js';

const API = 'https://api.air.inc/shorturl/';
export const normName = n => String(n || '').toLowerCase().replace(/\.(mp4|mov|jpe?g|png|gif|webp)$/i, '').replace(/\s*\(\d+\)$/, '').trim();

async function kids(sc, id) {
  let out = [], cursor = null;
  do {
    const j = await getJSON(API + sc + '/boards/' + id + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    out = out.concat(j.data || []);
    cursor = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
  } while (cursor);
  return out;
}
async function clips(sc, id) {
  let out = [], cursor = null;
  do {
    const body = { filters: { board: { is: id } }, limit: 100 };
    if (cursor) body.cursor = cursor;
    const j = await getJSON(API + sc + '/clips/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    out = out.concat((j.data && j.data.clips) || []);
    cursor = j.pagination && j.pagination.hasMore ? j.pagination.cursor : null;
  } while (cursor);
  return out;
}

// percorre a árvore em largura, com várias requisições em paralelo
async function crawl(folder) {
  const leaves = [];
  let level = [{ id: folder.root, path: [], anc: [] }];
  while (level.length) {
    const res = await pool(level, 8, async n => {
      const [k, c] = await Promise.all([kids(folder.shortcode, n.id), clips(folder.shortcode, n.id)]);
      return { n, k, c };
    });
    const next = [];
    for (const { n, k, c } of res) {
      if (!k.length && c.length && n.path.length) leaves.push({ ...n, clips: c });
      for (const b of k) next.push({ id: b.id, path: n.path.concat((b.title || '').trim()), anc: n.id === folder.root ? n.anc : [n.id, ...n.anc] });
    }
    level = next;
  }
  return leaves.map(l => ({ ...l, shortcode: folder.shortcode, folder }));
}

const MES = { JAN: 1, FEB: 2, FEV: 2, MAR: 3, APR: 4, ABR: 4, MAY: 5, MAI: 5, JUN: 6, JUL: 7, AUG: 8, AGO: 8, SEP: 9, SET: 9, OCT: 10, OUT: 10, NOV: 11, DEC: 12, DEZ: 12 };
// data do board de entrega ("ADS 09.30", "17.09", "10.02"): o mês da pasta (SEP 26, OCT 26...) decide a ordem dia/mês
function parseDate(label, folder) {
  const m = label.replace(/^ADS\s*/i, '').match(/(\d{1,2})[.\/](\d{1,2})/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  const fm = MES[String(folder.name || '').slice(0, 3).toUpperCase()];
  const yy = 2000 + (+(String(folder.name || '').match(/(\d{2})\s*$/) || [0, 26])[1]);
  let mo, d;
  if (fm && b === fm) { mo = b; d = a } else if (fm && a === fm) { mo = a; d = b } else if (a > 12) { mo = b; d = a } else { mo = a; d = b }
  return new Date(Date.UTC(yy, mo - 1, d));
}

// planilha de pedidos: board do Air (8 primeiros caracteres do id) -> tipo, objetivo, funil, status
// US: aba "US Request - Meta". BR: abas "Requisição BR" (e cópias), com a data de entrega na coluna W.
// link curto do Air (app.air.inc/a/<código>, sem /b/): descobre qual board ele abre. Guardado no banco (não muda).
async function resolveShort(codes) {
  let M = {};
  try { M = (await get('airsc')) || {} } catch (e) {}
  const miss = [...new Set(codes)].filter(c => !(c in M)).slice(0, 60);
  if (miss.length) {
    await pool(miss, 6, async c => { try { const j = await getJSON(API + c, {}, 2); M[c] = j && j.type === 'board' && j.data && j.data.id ? j.data.id.slice(0, 8) : '' } catch (e) {} });
    try { await put('airsc', M) } catch (e) {}
  }
  return M;
}
async function sheetIndex(key) {
  const doc = await get(key);
  if (!doc) return {};
  const idx = {};
  const short = l => [...l.matchAll(/app\.air\.inc\/a\/([0-9a-z]{6,12})(?![0-9a-z\/]*\/b\/)/gi)].map(m => m[1]);
  const SC = await resolveShort(doc.rows.flatMap(r => /needs approval|needs to approve/i.test(String(r[9] || '')) || !/\/b\//.test(String(r[20] || '')) ? short(String(r[20] || '')) : []));
  doc.rows.forEach((r, i) => {
    const link = String(r[20] || '');
    const refs = [...link.matchAll(/\/b\/([0-9a-f]{8})/g)].map(m => [m[1], '/b/' + m[1]]);
    for (const c of short(link)) if (SC[c]) refs.push([SC[c], '/a/' + c]);
    const row = r[26] ? +r[26] : i + 1, tab = r[25] || '';
    for (const [id, ref] of refs) idx[id] = { id, ref, row, tab, atype: (r[1] || '').trim(), obj: (r[6] || '').trim(), fun: (r[7] || '').trim(), st: (r[9] || '').trim(), date: key === 'sheet:criativosBR' ? sheetDate(r[22]) : null };
  });
  return idx;
}
// "02/09/2026" ou "2/9" (dia/mês) -> Date
function sheetDate(v) {
  const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 2026;
  if (+m[2] < 1 || +m[2] > 12) return null;
  return new Date(Date.UTC(y, +m[2] - 1, +m[1]));
}

function category(path, n, exts, own) {
  if (own && own.atype) { const t = own.atype.toUpperCase(); if (/CAROUSEL|CARROUSEL|CARROSS?EL/.test(t)) return 'Carousel'; if (/GIF/.test(t)) return 'GIF'; if (/VIDEO/.test(t)) return 'Video'; if (/STATIC/.test(t)) return 'Static'; }
  const up = path.join('/').toUpperCase();
  if (/CARROUSEL|CAROUSEL|CARROSS?EL/.test(up)) return 'Carousel';
  if (/\bGIFF?\b|GIFS/.test(up)) return 'GIF';
  if (/STATIC/.test(up)) return n <= 6 ? 'Static' : 'Carousel';
  if (/VIDEO/.test(up)) return 'Video';
  return exts.every(e => e === 'mp4') ? 'Video' : (n <= 6 ? 'Static' : 'Carousel');
}

async function build() {
  const US = config.airFolders.map(f => ({ ...f, mk: 'US' })), BR = (config.airFoldersBR || []).map(f => ({ ...f, mk: 'BR' }));
  const [sUS, sBR, ...folders] = await Promise.all([
    sheetIndex('sheet:criativos').catch(() => ({})), sheetIndex('sheet:criativosBR').catch(() => ({})),
    ...US.concat(BR).map(f => crawl(f).catch(e => { console.error('air', f.name, e.message); return [] }))]);
  const items = [];
  for (const L of folders.flat()) {
    const mk = L.folder.mk, sheet = mk === 'BR' ? sBR : sUS;
    const id8 = L.id.slice(0, 8);
    let s = sheet[id8], inherited = false;
    if (!s) for (const a of L.anc) { if (sheet[a.slice(0, 8)]) { s = sheet[a.slice(0, 8)]; inherited = true; break } }
    // data: do nome do board ("ADS 09.30"); se o board não tem data, a data de entrega da planilha (BR)
    const date = parseDate(L.path[0] || '', L.folder) || (s && s.date) || null;
    if (!date) continue;
    const exts = [...new Set(L.clips.map(c => c.ext))];
    const sq = L.clips.find(c => c.width === c.height) || L.clips[0];
    const obj = (s && s.obj) || overrides.obj[id8] || '';
    const dated = !!parseDate(L.path[0] || '', L.folder);
    // sem data no nome: o primeiro nível já é a campanha
    const path = dated ? L.path : ['', ...L.path];
    items.push({
      mk, date: iso(date), dd: iso(date).slice(8) + '/' + iso(date).slice(5, 7), wd: WD[(date.getUTCDay() + 6) % 7],
      week: iso(mondayOf(date)), month: iso(date).slice(0, 7),
      camp: path.length > 2 ? path[1] : '—', detail: path.length > 2 ? path.slice(2).join(' / ') : (path[1] || ''),
      cat: category(L.path, L.clips.length, exts, inherited ? null : s), obj, om: !s?.obj && !!overrides.obj[id8],
      fun: s ? s.fun : '', st: s ? s.st : '', row: s ? s.row : null, tab: s ? s.tab : '', sid: s ? s.id : '', ref: s ? s.ref : '',
      n: L.clips.length, dur: Math.round(Math.max(0, ...L.clips.map(c => c.duration || 0))),
      link: `https://app.air.inc/a/${L.shortcode}/b/${L.id}`,
      img: sq && sq.assets && sq.assets.image ? sq.assets.image + '?w=440&h=440&fit=crop&auto=format&q=75' : '',
      // nomes dos arquivos (para achar o mesmo criativo na Meta) e tipos de arquivo
      files: L.clips.map(c => normName(c.importedName || c.title || c.displayName)).filter(Boolean),
      fx: exts
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.camp.localeCompare(b.camp));
  return { updated: new Date().toISOString(), items };
}

export default async function handler(req, res) {
  try {
    const data = await cached('air4', 5 * 60e3, build);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
