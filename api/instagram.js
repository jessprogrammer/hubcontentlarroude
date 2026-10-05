// /api/instagram — posts e seguidores do @larroude direto da API do Instagram (Meta Graph API)
// Token de System User salvo no Vercel como META_ACCESS_TOKEN.
// O resultado fica guardado no banco (Upstash) e é atualizado aos poucos: cada chamada usa no máximo ~40 s,
// guarda o que conseguiu e devolve na hora o que já está pronto.
import config from '../config.js';
import base from '../data/fol-base.js';
import { pool, iso, mondayOf } from '../lib/util.js';
import { get, put } from '../lib/store.js';

const GRAPH = 'https://graph.facebook.com/v23.0';
const IG = process.env.IG_USER_ID || config.instagramAccount;
const KEY = 'ig:meta';
const FRESH_MS = 60 * 60e3;      // dados com menos de 1 h não são buscados de novo
const BUDGET_MS = 40e3;          // tempo máximo de busca por chamada
const DAYS_BACK = 180;           // posts dos últimos 6 meses

// aceita o token puro, com aspas, ou a linha inteira do .env (META_ACCESS_TOKEN=EAA...)
function token() {
  const v = String(process.env.META_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN || process.env.META_TOKEN || '');
  const m = v.match(/E?AA[A-Za-z0-9]{20,}/);
  if (m) return m[0].startsWith('E') ? m[0] : 'E' + m[0];
  return v.trim().replace(/^["']|["']$/g, '');
}
// nunca devolve o token (nem pedaços dele) em mensagens de erro
const redact = s => String(s || '').replace(/[A-Za-z0-9_-]{24,}/g, '[…]');
// formato do token salvo, sem mostrar o token
function tokenShape() {
  const v = String(process.env.META_ACCESS_TOKEN || '');
  return `token salvo: ${v.length} caracteres, começa com "${v.slice(0, 3).replace(/[^A-Za-z=_ ]/g, '?')}", tem "=": ${v.includes('=')}, tem aspas: ${/["']/.test(v)}, tem espaço/quebra: ${/\s/.test(v)}`;
}

async function graph(pathOrUrl, params, timeoutMs) {
  const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token());
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(3000, timeoutMs || 20000));
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.error) return j;
    const e = j.error || {};
    throw new Error('Meta ' + r.status + ' ' + (e.code || '') + ' ' + redact(e.message).slice(0, 200) + (e.code === 190 ? ' | ' + tokenShape() : ''));
  } finally { clearTimeout(t) }
}
const num = v => (v === '' || v == null ? 0 : +v || 0);
const day = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x };
const BASE_FIELDS = 'id,timestamp,media_type,media_product_type,permalink,caption,media_url,thumbnail_url,like_count,comments_count,children{media_type,media_url,thumbnail_url}';
const METRICS = 'reach,views,saved,shares,total_interactions';
const ins = o => Object.fromEntries(((o.insights && o.insights.data) || []).map(m => [m.name, num(m.values && m.values[0] && m.values[0].value)]));

async function mediaInsights(id, ms) {
  for (const metrics of [METRICS, 'reach,saved,shares,total_interactions', 'reach,saved']) {
    try { const j = await graph('/' + id + '/insights', { metric: metrics }, ms); return ins({ insights: j }) } catch (e) {}
  }
  return {};
}

async function posts(left) {
  const since = Date.now() - DAYS_BACK * 864e5;
  let list = [], url = '/' + IG + '/media', params = { fields: BASE_FIELDS + ',insights.metric(' + METRICS + ')', limit: '50' }, withIns = true;
  while (url && left() > 6000) {
    let j;
    try { j = await graph(url, params, left()) }
    catch (e) {
      if (!withIns) throw e;
      // algum post não aceita as métricas juntas: busca sem métricas e pede post a post
      withIns = false; params = { fields: BASE_FIELDS, limit: '50' }; url = '/' + IG + '/media'; list = []; continue;
    }
    list.push(...(j.data || []));
    const last = j.data && j.data[j.data.length - 1];
    if (!last || Date.parse(last.timestamp) < since) break;
    url = j.paging && j.paging.next; params = null;
  }
  list = list.filter(o => Date.parse(o.timestamp) >= since);
  if (!withIns) await pool(list, 8, async o => { if (left() > 3000) o._ins = await mediaInsights(o.id, left()) });
  return list.map(o => {
    const m = o._ins || ins(o);
    const f = o.media_type === 'VIDEO' ? 'Reels' : o.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : 'Imagem';
    const kid = o.children && o.children.data && o.children.data[0];
    const src = o.thumbnail_url || o.media_url || (kid && (kid.thumbnail_url || kid.media_url)) || '';
    return { ts: String(o.timestamp).replace('T', ' ').slice(0, 19), f, link: o.permalink, cap: String(o.caption || '').split(/\s+/).join(' ').slice(0, 140),
      reach: m.reach || 0, views: m.views || 0, inter: m.total_interactions || (num(o.like_count) + num(o.comments_count) + (m.saved || 0) + (m.shares || 0)),
      likes: num(o.like_count), comm: num(o.comments_count), saves: m.saved || 0, shares: m.shares || 0,
      img: src ? '/api/img?u=' + encodeURIComponent(src) : '' };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
}

// novos (FOLLOWER) e perdidos (NON_FOLLOWER) num intervalo de dias (a API aceita no máximo 30 dias por pedido)
async function gl(from, to, ms) {
  let g = 0, l = 0;
  for (let a = new Date(from); a <= to; a = day(a, 30)) {
    const b = day(a, 29) < to ? day(a, 29) : to;
    const j = await graph('/' + IG + '/insights', { metric: 'follows_and_unfollows', period: 'day', metric_type: 'total_value', breakdown: 'follow_type',
      since: String(Math.floor(a.getTime() / 1000)), until: String(Math.floor(day(b, 1).getTime() / 1000)) }, ms);
    const res = (((j.data || [])[0] || {}).total_value || {}).breakdowns;
    for (const r of ((res && res[0] && res[0].results) || [])) {
      const t = r.dimension_values && r.dimension_values[0];
      if (t === 'FOLLOWER') g += num(r.value); else if (t === 'NON_FOLLOWER') l += num(r.value);
    }
  }
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
      if (k === 'posts') { D.ig = await posts(left); D.igFetched = new Date().toISOString(); return }
      if (k === 'current') { const r = await graph('/' + IG, { fields: 'followers_count' }, left()); if (r.followers_count != null) { F.current = num(r.followers_count); F.asOf = today; F._cur = { fetched: today } } return }
      const v = await gl(a, b, left());
      if (k.startsWith('m:')) {
        const key = k.slice(2), last = iso(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5), 0)));
        F.months[key] = { g: v.g, l: v.l, to: v.to, ...(v.to !== last ? { note: 'Até ' + v.to.split('-').reverse().slice(0, 2).join('/') + '.' } : {}) };
      } else if (k.startsWith('w:')) {
        const w = k.slice(2); F._wto[w] = v.to;
        F.weeks = F.weeks.filter(x => x[0] !== w).concat([[w, v.g, v.l]]).sort((p, q) => p[0].localeCompare(q[0])).slice(-13);
      } else F[k] = v;
    } catch (e) { errors.push(k + ': ' + redact(e.message || e).slice(0, 300)) }
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
    if (!token()) throw new Error('META_ACCESS_TOKEN não configurado');
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
  } catch (e) { res.status(502).json({ error: redact(e.message || e) }) }
}
