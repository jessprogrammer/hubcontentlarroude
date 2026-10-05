// /api/meta-check — diagnóstico temporário: quais contas de anúncio o token enxerga e exemplos de nomes de anúncio.
// Não mostra o token nem valores de gasto.
const GRAPH = 'https://graph.facebook.com/v23.0';
function token() {
  const v = String(process.env.META_ACCESS_TOKEN || '');
  const m = v.match(/E?AA[A-Za-z0-9]{20,}/);
  return m ? (m[0].startsWith('E') ? m[0] : 'E' + m[0]) : v.trim();
}
const redact = s => String(s || '').replace(/[A-Za-z0-9_-]{24,}/g, '[…]');
async function g(path, params) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token());
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  if (j.error) return { error: redact(j.error.message), code: j.error.code };
  return j;
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const out = {};
  for (const id of ['2047856822417350', '312869193575906', '929449929417505']) {
    const o = out[id] = {};
    const imgs = await g('/act_' + id + '/adimages', { fields: 'name,created_time', limit: '15' });
    o.images = imgs.data ? imgs.data.map(x => x.name + ' @' + String(x.created_time).slice(0, 10)) : imgs.error;
    const vids = await g('/act_' + id + '/advideos', { fields: 'title,created_time', limit: '15' });
    o.videos = vids.data ? vids.data.map(x => x.title + ' @' + String(x.created_time).slice(0, 10)) : vids.error;
    const ads = await g('/act_' + id + '/ads', { fields: 'name,effective_status,adset{name},campaign{name},creative{name,title,image_hash,video_id,asset_feed_spec{images{hash},videos{video_id}},object_story_spec}', limit: '4', effective_status: '["ACTIVE"]' });
    o.ads = ads.data ? ads.data.map(x => ({ n: x.name, c: x.campaign && x.campaign.name, s: x.adset && x.adset.name, cr: x.creative && { name: x.creative.name, img: !!x.creative.image_hash, vid: !!x.creative.video_id, afs: !!x.creative.asset_feed_spec, oss: x.creative.object_story_spec ? Object.keys(x.creative.object_story_spec) : null } })) : ads.error;
  }
  res.status(200).json(out);
}
