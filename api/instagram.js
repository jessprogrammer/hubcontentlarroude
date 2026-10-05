// /api/instagram — posts e seguidores do @larroude via API do Supermetrics (env SUPERMETRICS_API_KEY)
import config from '../config.js';
import base from '../data/fol-base.js';
import { pool, cached, iso, mondayOf } from '../lib/util.js';

const SM = 'https://api.supermetrics.com/v2/query/data/json';
const ACC = config.instagramAccount;
// aceita a chave pura ou um trecho copiado do link do Query Manager (com %22, aspas, espaços...)
function apiKey() {
  let v = String(process.env.SUPERMETRICS_API_KEY || '');
  try { v = decodeURIComponent(v) } catch (e) {}
  const m = v.match(/api_[A-Za-z0-9_-]{20,}/);
  if (m) return m[0];
  const runs = (v.match(/[A-Za-z0-9_-]{20,}/g) || []).sort((x, y) => y.length - x.length);
  return runs[0] ? (runs[0].startsWith('api_') ? runs[0] : 'api_' + runs[0]) : v.trim();
}
// descreve o formato da chave salva, sem mostrar a chave
function keyShape() {
  const v = String(process.env.SUPERMETRICS_API_KEY || '');
  return `chave salva: ${v.length} caracteres, começa com "${v.slice(0, 4)}", tem %: ${v.includes('%')}, tem aspas: ${/["']/.test(v)}, tem espaço: ${/\s/.test(v)}`;
}

async function sm(fields, report_type, range) {
  const q = { ds_id: 'IGI', ds_accounts: ACC, fields, settings: { report_type }, max_rows: 5000, api_key: apiKey(), ...range };
  q.ds_user = process.env.IG_DS_USER || ACC;
  for (let k = 0; k < 3; k++) {
    const r = await fetch(SM + '?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.data)) return j.data.slice(1); // linha 0 = cabeçalho
    if (r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 1500 * (k + 1))); continue }
    throw new Error('Supermetrics ' + r.status + ' ' + JSON.stringify(j.error || j.meta || '').slice(0, 300) + ' | ' + keyShape());
  }
  throw new Error('Supermetrics sem resposta');
}
const num = v => (v === '' || v == null ? 0 : +v || 0);
const day = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x };

async function posts() {
  const F = ['media_id', 'timestamp', 'media_type', 'media_permalink', 'media_caption', 'media_url', 'media_thumbnail_url', 'media_reach', 'media_views', 'interactions', 'media_like_count', 'media_comments_count', 'media_saved', 'media_shares'];
  const rows = await sm(F.join(','), 'AccountMedia', { date_range_type: 'last_180_days' });
  const seen = new Set(), out = [];
  for (const r of rows) {
    const o = Object.fromEntries(F.map((f, i) => [f, r[i]]));
    if (seen.has(o.media_id)) continue; seen.add(o.media_id);
    const f = o.media_type === 'VIDEO' ? 'Reels' : o.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : 'Imagem';
    const src = o.media_type === 'VIDEO' ? (o.media_thumbnail_url || o.media_url) : (o.media_url || o.media_thumbnail_url);
    out.push({ ts: String(o.timestamp).replace('T', ' ').slice(0, 19), f, link: o.media_permalink, cap: String(o.media_caption || '').split(/\s+/).join(' ').slice(0, 140),
      reach: num(o.media_reach), views: num(o.media_views), inter: num(o.interactions), likes: num(o.media_like_count), comm: num(o.media_comments_count), saves: num(o.media_saved), shares: num(o.media_shares),
      img: src ? '/api/img?u=' + encodeURIComponent(src) : '' });
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

// novos (FOLLOWER) e perdidos (NON_FOLLOWER) num intervalo
async function gl(from, to) {
  const rows = await sm('follow_type,follows_and_unfollows', 'AccountFollowTypes', { start_date: iso(from), end_date: iso(to) });
  let g = 0, l = 0;
  for (const [t, v] of rows) { if (t === 'FOLLOWER') g += num(v); else if (t === 'NON_FOLLOWER') l += num(v) }
  return { g, l, from: iso(from), to: iso(to) };
}

async function followers() {
  const F = JSON.parse(JSON.stringify(base)); // histórico guardado (inclui o erro do Instagram em julho)
  const y = day(new Date(), -1); y.setUTCHours(0, 0, 0, 0); // ontem = último dia completo
  try { const r = await sm('followers_count', 'AccountCommon', { date_range_type: 'yesterday' }); if (r[0]) { F.current = num(r[0][0]); F.asOf = iso(y) } } catch (e) {}
  const jobs = [
    ['last1', y, y], ['last7', day(y, -6), y], ['last30', day(y, -29), y],
  ];
  // meses a partir de agosto (julho fica do histórico por causa do erro do Instagram)
  for (let m = new Date(Date.UTC(2026, 7, 1)); m <= y; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
    jobs.push(['m:' + iso(m).slice(0, 7), m, end < y ? end : y]);
  }
  // últimas 13 semanas (seg–dom)
  const mon = mondayOf(y);
  for (let i = 12; i >= 0; i--) { const a = day(mon, -7 * i), b = day(a, 6); if (iso(a) >= '2026-08-03') jobs.push(['w:' + iso(a), a, b < y ? b : y]) }
  const res = await pool(jobs, 4, async ([k, a, b]) => { try { return [k, await gl(a, b)] } catch (e) { return [k, null] } });
  const weeks = new Map(F.weeks.map(w => [w[0], w]));
  for (const [k, v] of res) {
    if (!v) continue;
    if (k.startsWith('m:')) { const key = k.slice(2); F.months[key] = { g: v.g, l: v.l, ...(v.to.slice(0, 7) === key && v.to !== iso(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5), 0))) ? { note: 'Até ' + v.to.split('-').reverse().slice(0, 2).join('/') + '.' } : {}) } }
    else if (k.startsWith('w:')) weeks.set(k.slice(2), [k.slice(2), v.g, v.l]);
    else F[k] = v;
  }
  F.weeks = [...weeks.values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-13);
  return F;
}

async function build() {
  if (!process.env.SUPERMETRICS_API_KEY) throw new Error('SUPERMETRICS_API_KEY não configurada');
  const [ig, fol] = await Promise.all([posts(), followers()]);
  return { updated: new Date().toISOString(), ig, fol };
}

export default async function handler(req, res) {
  try {
    const data = await cached('ig', 30 * 60e3, build);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
}
