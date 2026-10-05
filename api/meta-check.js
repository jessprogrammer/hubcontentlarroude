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
  const perms = await g('/me/permissions');
  const me = await g('/me', { fields: 'id,name' });
  const accts = await g('/me/adaccounts', { fields: 'name,account_id,account_status,currency', limit: '50' });
  const out = { me: me.name || me.error, permissions: perms.data ? perms.data.filter(p => p.status === 'granted').map(p => p.permission) : perms.error, adaccounts: accts.data || accts.error };
  if (accts.data) {
    out.samples = {};
    for (const a of accts.data.slice(0, 6)) {
      const ads = await g('/act_' + a.account_id + '/ads', { fields: 'name,effective_status', limit: '8' });
      out.samples[a.name] = ads.data ? ads.data.map(x => x.name + ' [' + x.effective_status + ']') : ads.error;
    }
  }
  res.status(200).json(out);
}
