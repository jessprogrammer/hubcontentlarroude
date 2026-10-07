// /api/ads — status e performance dos criativos na Meta (contas Larroudé US e PRE-ORDER US).
// Liga o criativo do Air ao anúncio pelo nome do arquivo de vídeo (o título do vídeo na Meta é o nome do arquivo).
// Resultado guardado no banco por 1 h para o site abrir rápido.
import { get, put } from '../lib/store.js';
import { pool } from '../lib/util.js';

const GRAPH = 'https://graph.facebook.com/v23.0';
const ACCOUNTS = [{ id: '2047856822417350', name: 'Larroudé US' }, { id: '929449929417505', name: 'PRE-ORDER US' }];
const KEY = 'ads:meta5';
const FRESH_MS = 60 * 60e3;
const SINCE = '2026-08-01'; // período considerado para "total"

function token() {
  const v = String(process.env.META_ACCESS_TOKEN || '');
  const m = v.match(/E?AA[A-Za-z0-9]{20,}/);
  return m ? (m[0].startsWith('E') ? m[0] : 'E' + m[0]) : v.trim();
}
const redact = s => String(s || '').replace(/[A-Za-z0-9_-]{24,}/g, '[…]');
const normName = n => String(n || '').toLowerCase().replace(/\.(mp4|mov|jpe?g|png|gif|webp)$/i, '').replace(/\s*\(\d+\)$/, '').trim();

// chave a partir do nome: código_TIPO_CONSCIÊNCIA_ÂNGULO_NN (Air) ↔ código_Tipo_Destino_Consciência_Ângulo_VNN (anúncio)
const keyOf = n => {
  const p = String(n || '').toLowerCase().replace(/\.(mp4|mov|jpe?g|png|gif)$/, '').split('_').filter(Boolean);
  if (p.length < 4) return '';
  const ai = p.findIndex((t, i) => i > 0 && /aware|no-copy|nocopy/.test(t));
  if (ai < 0) return '';
  let j = ai + 1, ang = [], num = '';
  for (; j < p.length; j++) { const m = p[j].match(/^v?(\d{1,3})$/); if (m) { num = String(+m[1]); break } ang.push(p[j]) }
  if (!num) num = '1';
  return 'k:' + p[0] + '|' + p[ai].replace(/[^a-z]/g, '') + '|' + ang.join('').replace(/[^a-z0-9]/g, '') + '|' + num;
};

async function graph(pathOrUrl, params) {
  const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token());
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + (j.error.code || r.status) + ' ' + redact(j.error.message).slice(0, 160));
    return j;
  } finally { clearTimeout(t) }
}
async function all(path, params, max = 20) {
  let out = [], j = await graph(path, params), n = 0;
  while (true) {
    out = out.concat(j.data || []);
    if (!j.paging || !j.paging.next || ++n >= max) break;
    j = await graph(j.paging.next);
  }
  return out;
}
const num = v => +v || 0;
const act = (list, types) => { for (const t of types) { const a = (list || []).find(x => x.action_type === t); if (a) return num(a.value) } return 0 };
const PURCH = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];

async function account(acc, today) {
  const since = Math.floor(Date.parse(SINCE) / 1000);
  const [videos, ads, ins, ins7, images] = await Promise.all([
    all('/act_' + acc.id + '/advideos', { fields: 'id,title', limit: '500' }, 6),
    all('/act_' + acc.id + '/ads', { fields: 'id,name,effective_status,creative{object_type,image_hash,video_id,asset_feed_spec{images{hash},videos{video_id}},object_story_spec{video_data{video_id,image_hash},link_data{image_hash,child_attachments{video_id,image_hash}}}}', limit: '200', updated_since: String(since) }, 15),
    all('/act_' + acc.id + '/insights', { level: 'ad', fields: 'ad_id,spend,impressions,clicks,actions,action_values', time_range: JSON.stringify({ since: SINCE, until: today }), limit: '500' }, 10),
    all('/act_' + acc.id + '/insights', { level: 'ad', fields: 'ad_id,spend,impressions,clicks,actions,action_values', date_preset: 'last_7d', limit: '500' }, 10),
    all('/act_' + acc.id + '/adimages', { fields: 'hash,created_time', limit: '500' }, 4),
  ]);
  const byVideo = {}, byHash = {};
  for (const a of ads) {
    const c = a.creative || {}, vids = new Set();
    if (c.video_id) vids.add(c.video_id);
    ((c.asset_feed_spec && c.asset_feed_spec.videos) || []).forEach(v => v.video_id && vids.add(v.video_id));
    const oss = c.object_story_spec || {};
    if (oss.video_data && oss.video_data.video_id) vids.add(oss.video_data.video_id);
    ((oss.link_data && oss.link_data.child_attachments) || []).forEach(v => v.video_id && vids.add(v.video_id));
    for (const v of vids) (byVideo[v] = byVideo[v] || []).push(a.id);
    const hs = new Set();
    if (c.image_hash) hs.add(c.image_hash);
    ((c.asset_feed_spec && c.asset_feed_spec.images) || []).forEach(i => i.hash && hs.add(i.hash));
    if (oss.link_data && oss.link_data.image_hash) hs.add(oss.link_data.image_hash);
    ((oss.link_data && oss.link_data.child_attachments) || []).forEach(v => v.image_hash && hs.add(v.image_hash));
    for (const h of hs) (byHash[h] = byHash[h] || []).push(a.id);
  }
  const metr = r => ({ sp: num(r.spend), im: num(r.impressions), cl: num(r.clicks), pu: act(r.actions, PURCH), rv: act(r.action_values, PURCH) });
  const I = Object.fromEntries(ins.map(r => [r.ad_id, metr(r)]));
  const I7 = Object.fromEntries(ins7.map(r => [r.ad_id, metr(r)]));
  const adOut = {};
  for (const a of ads) adOut[a.id] = { n: a.name, st: a.effective_status, acc: acc.name, t: I[a.id] || null, w: I7[a.id] || null };
  const names = {};
  for (const v of videos) {
    const n = normName(v.title);
    if (n.length < 8 || !byVideo[v.id]) continue;
    names[n] = Array.from(new Set((names[n] || []).concat(byVideo[v.id])));
  }
  // também liga pelo nome do anúncio (segue a mesma nomenclatura do arquivo no Air)
  for (const a of ads) { const k = keyOf(a.name); if (k) names[k] = Array.from(new Set((names[k] || []).concat(a.id))) }
  for (const [h, ids] of Object.entries(byHash)) names['h:' + h] = Array.from(new Set((names['h:' + h] || []).concat(ids)));
  const vidIds = new Set(videos.map(v => v.id)), adVid = Object.keys(byVideo);
  const dbg = { videos: videos.length, ads: ads.length, adsWithVideo: new Set(Object.values(byVideo).flat()).size, adVideoIds: adVid.length, adVideoIdsInLibrary: adVid.filter(v => vidIds.has(v)).length,
    images: images.length, hashedAds: new Set(Object.values(byHash).flat()).size, types: ads.reduce((m, a) => { const t = (a.creative && a.creative.object_type) || '?'; m[t] = (m[t] || 0) + 1; return m }, {}) };
  // guarda só os anúncios ligados a algum vídeo com nome
  const used = new Set(Object.values(names).flat());
  return { names, dbg, ads: adOut };
}

async function build() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await pool(ACCOUNTS, 2, async acc => { try { return await account(acc, today) } catch (e) { return { error: acc.name + ': ' + redact(e.message) } } });
  const out = { updated: new Date().toISOString(), since: SINCE, names: {}, ads: {}, errors: [], dbg: {} };
  for (const r of res) {
    if (r.error) { out.errors.push(r.error); continue }
    Object.assign(out.ads, r.ads); out.dbg[Object.keys(out.dbg).length] = r.dbg;
    for (const [n, ids] of Object.entries(r.names)) out.names[n] = Array.from(new Set((out.names[n] || []).concat(ids)));
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let D = await get(KEY);
    // a reconstrução leva até ~1 min: o site recebe na hora o que já está salvo; quem atualiza é o Apps Script (?refresh=1, a cada 10 min).
    // Só reconstrói aqui se não houver nada salvo ou se os dados tiverem mais de 3 h.
    const age = D ? Date.now() - Date.parse(D.updated) : Infinity;
    const want = (req.query && req.query.refresh) ? (age > FRESH_MS / 4 || (D.errors && D.errors.length)) : age > 3 * FRESH_MS;
    if (!D || want) {
      const fresh = await build();
      if (Object.keys(fresh.ads).length || !D) { D = fresh; await put(KEY, D) }
    }
    res.status(200).json(D);
  } catch (e) { res.status(502).json({ error: redact(e.message || e) }) }
}
