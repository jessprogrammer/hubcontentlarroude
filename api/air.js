// /api/air — criativos entregues, lidos ao vivo das pastas mensais do Air
// + tipo/status da planilha "US Request - Meta" (CSV publicado na web, env CRIATIVOS_CSV_URL)
import config from '../config.js';
import overrides from '../overrides.js';
import { pool, getJSON, cached, WD, iso, mondayOf } from '../lib/util.js';
import { get } from '../lib/store.js';

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

async function sheetIndex() {
  const doc = await get('sheet:criativos');
  if (!doc) return {};
  const idx = {};
  doc.rows.forEach((r, i) => {
    const ids = [...String(r[20] || '').matchAll(/\/b\/([0-9a-f]{8})/g)].map(m => m[1]);
    for (const id of ids) idx[id] = { row: i + 1, atype: (r[1] || '').trim(), obj: (r[6] || '').trim(), fun: (r[7] || '').trim(), st: (r[9] || '').trim() };
  });
  return idx;
}

function category(path, n, exts, own) {
  if (own && own.atype) { const t = own.atype.toUpperCase(); if (/CAROUSEL|CARROUSEL/.test(t)) return 'Carousel'; if (/GIF/.test(t)) return 'GIF'; if (/VIDEO/.test(t)) return 'Video'; if (/STATIC/.test(t)) return 'Static'; }
  const up = path.join('/').toUpperCase();
  if (/CARROUSEL|CAROUSEL/.test(up)) return 'Carousel';
  if (/\bGIFF?\b|GIFS/.test(up)) return 'GIF';
  if (/STATIC/.test(up)) return n <= 6 ? 'Static' : 'Carousel';
  if (/VIDEO/.test(up)) return 'Video';
  return exts.every(e => e === 'mp4') ? 'Video' : (n <= 6 ? 'Static' : 'Carousel');
}

async function build() {
  const [sheet, ...folders] = await Promise.all([sheetIndex().catch(() => ({})), ...config.airFolders.map(f => crawl(f))]);
  const items = [];
  for (const L of folders.flat()) {
    const date = parseDate(L.path[0] || '', L.folder);
    if (!date) continue;
    const id8 = L.id.slice(0, 8);
    let s = sheet[id8], inherited = false;
    if (!s) for (const a of L.anc) { if (sheet[a.slice(0, 8)]) { s = sheet[a.slice(0, 8)]; inherited = true; break } }
    const exts = [...new Set(L.clips.map(c => c.ext))];
    const sq = L.clips.find(c => c.width === c.height) || L.clips[0];
    const obj = (s && s.obj) || overrides.obj[id8] || '';
    items.push({
      date: iso(date), dd: iso(date).slice(8) + '/' + iso(date).slice(5, 7), wd: WD[(date.getUTCDay() + 6) % 7],
      week: iso(mondayOf(date)), month: iso(date).slice(0, 7),
      camp: L.path.length > 2 ? L.path[1] : '—', detail: L.path.length > 2 ? L.path.slice(2).join(' / ') : (L.path[1] || ''),
      cat: category(L.path, L.clips.length, exts, inherited ? null : s), obj, om: !s?.obj && !!overrides.obj[id8],
      fun: s ? s.fun : '', st: s ? s.st : '', row: s ? s.row : null,
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
    const data = await cached('air', 5 * 60e3, build);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
