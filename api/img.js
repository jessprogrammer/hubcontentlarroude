// /api/img?u=... — repassa miniaturas do Instagram (o CDN deles bloqueia uso direto em outros sites)
const OK = /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net)\//i;
export default async function handler(req, res) {
  const u = String(req.query.u || '');
  if (!OK.test(u)) return res.status(400).end('bad url');
  try {
    const r = await fetch(u);
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, max-age=86400');
    res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).end(); }
}
