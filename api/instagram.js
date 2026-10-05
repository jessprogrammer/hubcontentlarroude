// /api/instagram — posts e seguidores do @larroude via API do Supermetrics (env SUPERMETRICS_API_KEY)
// O Supermetrics é lento, então o resultado fica guardado no banco (Upstash) e é atualizado aos poucos:
// cada chamada usa no máximo ~40 s, guarda o que conseguiu e devolve na hora o que já está pronto.
import config from '../config.js';
import base from '../data/fol-base.js';
import { pool, iso, mondayOf } from '../lib/util.js';
import { get, put } from '../lib/store.js';

const SM = 'https://api.supermetrics.com/v2/query/data/json';
const ACC = config.instagramAccount;
const KEY = 'ig:data';
const FRESH_MS = 60 * 60e3;      // dados com menos de 1 h não são buscados de novo
const BUDGET_MS = 40e3;          // tempo máximo de busca por chamada

// aceita a chave pura ou um trecho copiado do link do Query Manager (com %22, aspas, espaços...)
function apiKey() {
  let v = String(process.env.SUPERMETRICS_API_KEY || '');
  try { v = decodeURIComponent(v) } catch (e) {}
  const m = v.match(/api_[A-Za-z0-9_-]{20,}/);
  if (m) return m[0];
  const runs = (v.match(/[A-Za-z0-9_-]{20,}/g) || []).sort((x, y) => y.length - x.length);
  return runs[0] ? (runs[0].startsWith('api_') ? runs[0] : 'api_' + runs[0]) : v.trim();
}

async function sm(fields, range, timeoutMs) {
  const q = { ds_id: 'IGI', ds_accounts: ACC, ds_user: process.env.IG_DS_USER || ACC, fields, max_rows: 5000, api_key: apiKey(), ...range };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(3000, timeoutMs));
  try {
    const r = await fetch(SM + '?json=' + encodeURIComponent(JSON.stringify(q)), { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.data)) return j.data.slice(1); // linha 0 = cabeçalho
    throw new Error('Supermetrics ' + r.status + ' ' + JSON.stringify(j.error || j.meta || '').slice(0, 300));
  } finally { clearTimeout(t) }
}
const num = v => (v === '' || v == null ? 0 : +v || 0);
const day = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x };

async function posts(ms) {
  const F = ['media_id', 'timestamp', 'media_type', 'media_permalink', 'media_caption', 'media_url', 'media_thumbnail_url', 'media_reach', 'media_views', 'interactions', 'media_like_count', 'media_comments_count', 'media_saved', 'media_shares'];
  const rows = await sm(F.join(','), { date_range_type: 'last_180_days' }, ms);
  const seen = new Set(), out = [];
  for (const r of rows) {
    const o = Object.fromEntries(F.map((f, i) => [f, r[i]]));
    if (!o.media_id || seen.has(o.media_id)) continue; seen.add(o.media_id);
    const f = o.media_type === 'VIDEO' ? 'Reels' : o.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : 'Imagem';
    const src = o.media_type === 'VIDEO' ? (o.media_thumbnail_url || o.media_url) : (o.media_url || o.media_thumbnail_url);
    out.push({ ts: String(o.timestamp).replace('T', ' ').slice(0, 19), f, link: o.media_permalink, cap: String(o.media_caption || '').split(/\s+/).join(' ').slice(0, 140),
      reach: num(o.media_reach), views: num(o.media_views), inter: num(o.interactions), likes: num(o.media_like_count), comm: num(o.media_comments_count), saves: num(o.media_saved), shares: num(o.media_shares),
      img: src ? '/api/img?u=' + encodeURIComponent(src) : '' });
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

// novos (FOLLOWER) e perdidos (NON_FOLLOWER) num intervalo
async function gl(from, to, ms) {
  const rows = await sm('follow_type,follows_and_unfollows', { start_date: iso(from), end_date: iso(to) }, ms);
  let g = 0, l = 0;
  for (const [t, v] of rows) { if (t === 'FOLLOWER') g += num(v); else if (t === 'NON_FOLLOWER') l += num(v) }
  return { g, l, from: iso(from), to: iso(to) };
}

// lista do que precisa ser buscado, do mais importante para o menos
function jobsFor(F, y, today) {
  const jobs = [];
  const stale = x => !x || x.fetched !== today; // números que mudam todo dia
  if (stale(F._cur)) jobs.push(['current']);
  for (const [k, a] of [['last1', y], ['last7', day(y, -6)], ['last30', day(y, -29)]]) if (!F[k] || F[k].to !== iso(y)) jobs.push([k, a, y]);
  // meses a partir de agosto (julho fica do histórico por causa do erro do Instagram)
  for (let m = new Date(Date.UTC(2026, 7, 1)); m <= y; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const key = iso(m).slice(0, 7), end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
    const to = end < y ? end : y, have = F.months[key];
    if (!have || !have.to || have.to < iso(to)) jobs.push(['m:' + key, m, to]);
  }
  // últimas 13 semanas (seg–dom); semanas fechadas só são buscadas uma vez
  const mon = mondayOf(y);
  for (let i = 0; i <= 12; i++) {
    const a = day(mon, -7 * i), b = day(a, 6), to = b < y ? b : y, k = iso(a);
    if (k < '2026-08-03') continue;
    const have = (F._wto || {})[k];
    if (!have || have < iso(to)) jobs.push(['w:' + k, a, to]);
  }
  return jobs;
}

async function refresh(prev) {
  const start = Date.now(), left = () => BUDGET_MS - (Date.now() - start);
  const D = prev ? JSON.parse(JSON.stringify(prev)) : { ig: [], fol: JSON.parse(JSON.stringify(base)) };
  const F = D.fol; F._wto = F._wto || {};
  const y = day(new Date(), -1); y.setUTCHours(0, 0, 0, 0); // ontem = último dia completo
  const today = iso(new Date());
  const errors = [];

  const tasks = [];
  if (!D.igFetched || Date.now() - Date.parse(D.igFetched) > FRESH_MS) tasks.push(['posts']);
  tasks.push(...jobsFor(F, y, today));

  await pool(tasks, 4, async ([k, a, b]) => {
    if (left() < 4000) return;
    try {
      if (k === 'posts') { D.ig = await posts(left()); D.igFetched = new Date().toISOString(); return }
      if (k === 'current') { const r = await sm('followers_count', { date_range_type: 'yesterday' }, left()); if (r[0]) { F.current = num(r[0][0]); F.asOf = iso(y); F._cur = { fetched: today } } return }
      const v = await gl(a, b, left());
      if (k.startsWith('m:')) {
        const key = k.slice(2), last = iso(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5), 0)));
        F.months[key] = { g: v.g, l: v.l, to: v.to, ...(v.to !== last ? { note: 'Até ' + v.to.split('-').reverse().slice(0, 2).join('/') + '.' } : {}) };
      } else if (k.startsWith('w:')) {
        const w = k.slice(2); F._wto[w] = v.to;
        F.weeks = F.weeks.filter(x => x[0] !== w).concat([[w, v.g, v.l]]).sort((p, q) => p[0].localeCompare(q[0])).slice(-13);
      } else F[k] = v;
    } catch (e) { errors.push(k + ': ' + String(e.message || e).slice(0, 200)) }
  });
  D.updated = new Date().toISOString();
  D.pending = jobsFor(F, y, today).length + (D.igFetched ? 0 : 1);
  if (errors.length) D.errors = errors.slice(0, 5); else delete D.errors;
  await put(KEY, D);
  return D;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.SUPERMETRICS_API_KEY) throw new Error('SUPERMETRICS_API_KEY não configurada');
    let D = await get(KEY);
    const old = !D || !D.updated || Date.now() - Date.parse(D.updated) > FRESH_MS || D.pending > 0 || !D.ig || !D.ig.length;
    if (old) {
      const before = D && D.igFetched;
      D = await refresh(D);
      // posts novos: já aquece as miniaturas no cache do site, para abrirem rápido
      if (D.igFetched && D.igFetched !== before && req.headers && req.headers.host) {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        await pool(D.ig.slice(0, 60), 12, p => fetch('https://' + req.headers.host + p.img, { signal: ctl.signal }).then(r => r.arrayBuffer()).catch(() => null));
        clearTimeout(t);
      }
    }
    if (!D.ig || !D.ig.length) return res.status(502).json({ error: (D.errors || ['ainda buscando os posts']).join(' · ') });
    const { _wto, _cur, ...fol } = D.fol;
    res.status(200).json({ updated: D.igFetched || D.updated, ig: D.ig, fol, pending: D.pending || 0 });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }) }
}
