// Live on Meta: todos os anúncios ATIVOS agora nas contas de anúncio que o token da Meta enxerga.
// Servido por /api/ads?src=live (dentro do /api/ads porque o plano do Vercel aceita no máximo 12 funções).
// Usa o mesmo token do Entregas (env META_ACCESS_TOKEN). Só leitura: nada é alterado na Meta.
// GET            → { updated, accounts:[{id,name,cur,n}], ads:[...], errors }   (guardado no banco por 15 min)
// GET ?refresh=1 → relê a Meta agora
import { get, put } from './store.js';
import { pool } from './util.js';

const GRAPH = 'https://graph.facebook.com/v23.0';
const KEY = 'ads:live1';
const FRESH_MS = 15 * 60e3;

function token() {
  const v = String(process.env.META_ACCESS_TOKEN || '');
  const m = v.match(/E?AA[A-Za-z0-9]{20,}/);
  return m ? (m[0].startsWith('E') ? m[0] : 'E' + m[0]) : v.trim();
}
const redact = s => String(s || '').replace(/[A-Za-z0-9_-]{24,}/g, '[…]');
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = v => +v || 0;

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
const act = (list, types) => { for (const t of types) { const a = (list || []).find(x => x.action_type === t); if (a) return num(a.value) } return 0 };
const PURCH = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
const metr = r => r ? { sp: num(r.spend), im: num(r.impressions), cl: num(r.clicks), pu: act(r.actions, PURCH), rv: act(r.action_values, PURCH) } : null;

async function account(acc) {
  const id = acc.id.replace(/^act_/, '');
  const [ads, ins] = await Promise.all([
    all('/act_' + id + '/ads', {
      effective_status: JSON.stringify(['ACTIVE']),
      fields: 'id,name,created_time,campaign{id,name,objective},adset{id,name,daily_budget,lifetime_budget},creative{object_type,thumbnail_url,image_url,video_id,instagram_permalink_url,effective_object_story_id},preview_shareable_link',
      thumbnail_width: '480', thumbnail_height: '480', limit: '200',
    }, 15),
    all('/act_' + id + '/insights', { level: 'ad', fields: 'ad_id,spend,impressions,clicks,actions,action_values', date_preset: 'last_7d', filtering: JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }]), limit: '500' }, 10).catch(() => []),
  ]);
  const I = Object.fromEntries(ins.map(r => [r.ad_id, metr(r)]));
  return ads.map(a => {
    const c = a.creative || {}, cp = a.campaign || {}, as = a.adset || {};
    const story = String(c.effective_object_story_id || '');
    return {
      id: a.id, n: str(a.name, 200), acc: id, accN: str(acc.name, 80), cur: acc.currency || 'USD',
      since: a.created_time || '', camp: str(cp.name, 160), campId: cp.id || '', obj: str(cp.objective, 40),
      set: str(as.name, 160), setId: as.id || '', bud: num(as.daily_budget) / 100 || 0, budL: num(as.lifetime_budget) / 100 || 0,
      type: c.video_id || /VIDEO/i.test(c.object_type || '') ? 'video' : /SHARE|CAROUSEL/i.test(c.object_type || '') ? 'post' : 'image',
      th: str(c.thumbnail_url || c.image_url, 1200),
      ig: str(c.instagram_permalink_url, 300),
      fb: story && story.includes('_') ? 'https://www.facebook.com/' + story.split('_')[0] + '/posts/' + story.split('_')[1] : '',
      prev: str(a.preview_shareable_link, 400),
      w: I[a.id] || null,
    };
  });
}

async function build() {
  const accs = await all('/me/adaccounts', { fields: 'id,name,currency,account_status', limit: '100' }, 3);
  const live = accs.filter(a => a.account_status === 1);
  const out = { updated: new Date().toISOString(), accounts: [], ads: [], errors: [] };
  const res = await pool(live, 3, async a => { try { return { a, ads: await account(a) } } catch (e) { return { a, error: a.name + ': ' + redact(e.message) } } });
  for (const r of res) {
    if (r.error) { out.errors.push(r.error); continue }
    if (!r.ads.length) continue;
    out.accounts.push({ id: r.a.id.replace(/^act_/, ''), name: str(r.a.name, 80), cur: r.a.currency || 'USD', n: r.ads.length });
    out.ads = out.ads.concat(r.ads);
  }
  return out;
}

export default async function live(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let D = await get(KEY);
    const age = D ? Date.now() - Date.parse(D.updated) : Infinity;
    const want = req.query && req.query.refresh ? age > 60e3 : age > FRESH_MS;
    if (!D || want) {
      const fresh = await build();
      if (fresh.ads.length || !D || !fresh.errors.length) { D = fresh; await put(KEY, D) }
    }
    res.status(200).json(D);
  } catch (e) { res.status(502).json({ error: redact(e.message || e) }) }
}
