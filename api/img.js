// /api/img?u=... — repassa miniaturas do Instagram (o CDN deles bloqueia uso direto em outros sites)
// As fotos do Instagram vêm em tamanho cheio (~600 KB, 1080 px) e o hub mostra a ~180 px:
// aqui elas são reduzidas para 400 px (JPEG) antes de sair, para gastar ~95% menos transferência do Vercel.
// Se a redução falhar por qualquer motivo, devolve a imagem original (nada quebra).
import sharp from 'sharp';
const OK = /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net)\//i;
export default async function handler(req, res) {
  const u = String(req.query.u || '');
  if (!OK.test(u)) return res.status(400).end('bad url');
  try {
    const r = await fetch(u);
    if (!r.ok) return res.status(r.status).end();
    let buf = Buffer.from(await r.arrayBuffer()), type = r.headers.get('content-type') || 'image/jpeg';
    try { buf = await sharp(buf).rotate().resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer(); type = 'image/jpeg' } catch (e) {}
    res.setHeader('Content-Type', type);
    // o endereço do Instagram muda quando a imagem muda: pode ficar guardado no CDN por 30 dias
    res.setHeader('Cache-Control', 'public, s-maxage=2592000, max-age=2592000, immutable');
    res.status(200).send(buf);
  } catch (e) { res.status(502).end(); }
}
