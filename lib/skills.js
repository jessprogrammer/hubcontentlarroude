// Painel Skills: biblioteca das skills do time (arquivos em skills/, gerados por build/skills_catalog.py).
// Servido por /api/copy?src=skills (dentro do Copy porque o plano do Vercel aceita no máximo 12 funções).
// Tudo protegido pela senha do Copy:
//   POST { password, action: 'list' } → catálogo + links de download válidos por 2 h
//   GET  ?src=skills&f=<arquivo>&exp=<ms>&t=<assinatura> → o arquivo (.zip ou guia .html)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(process.cwd(), 'skills');
const pass = () => process.env.COPY_PASSWORD || process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD || '';
const sign = (f, exp) => crypto.createHmac('sha256', 'skills:' + pass()).update(f + '|' + exp).digest('hex').slice(0, 32);
const TYPES = { '.zip': 'application/zip', '.html': 'text/html; charset=utf-8' };

function catalog() { return JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8')) }
function allowed(f) {
  const C = catalog();
  return C.skills.some(s => s.zip === f) || C.guides.some(g => g.file === f);
}

export default async function skills(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      const f = String(q.f || ''), exp = +q.exp || 0;
      if (!pass() || !allowed(f) || exp < Date.now() || q.t !== sign(f, exp)) return res.status(403).end('Link expirado. Abra o painel Skills de novo.');
      const buf = fs.readFileSync(path.join(DIR, f));
      res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
      if (f.endsWith('.zip')) res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(f) + '"');
      res.setHeader('X-Robots-Tag', 'noindex');
      return res.status(200).end(buf);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    if (!pass() || String(body.password || '') !== pass()) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: 'senha' }) }
    const C = catalog();
    const exp = Date.now() + 2 * 3600e3;
    const link = f => '/api/copy?src=skills&f=' + encodeURIComponent(f) + '&exp=' + exp + '&t=' + sign(f, exp);
    res.status(200).json({
      generated: C.generated,
      skills: C.skills.map(s => ({ ...s, url: link(s.zip) })),
      guides: C.guides.map(g => ({ ...g, url: link(g.file) }))
    });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
