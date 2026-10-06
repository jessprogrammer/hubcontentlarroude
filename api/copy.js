// /api/copy — banco de copy (frases reutilizáveis), por mercado. Por enquanto: US.
// GET  /api/copy?mk=US                → { items, updated, clientId, approvers }
// POST /api/copy { auth, action, mk, ... }
//   auth: { password }  (time: adiciona e edita copys pendentes)
//         { idToken }   (login com Google de quem aprova: aprova, remove e edita tudo)
//   action: 'check' | 'whoami' | 'save' | 'bulk' | 'approve' | 'delete'
// Copy nova entra como "Aguardando aprovação". Só quem está em config.copyApprovers aprova ou remove.
import config from '../config.js';
import { get, put } from '../lib/store.js';
import { catalog } from './products.js';
import seedUS from '../data/copy-seed-us.js';
import seedCyprus from '../data/copy-seed-us-cyprus.js';

const MKS = ['US', 'BR'];
// etapas do funil (consciência), iguais aos nomes dos anúncios
export const FUNNEL = config.copyFunnel || ['Branding', 'Problem awareness', 'Product awareness', 'Most aware / Conversion'];
const SEEDS = { US: [seedUS, seedCyprus] };
const APPROVERS = (config.copyApprovers || []).map(e => e.toLowerCase());
const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || '';
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const newId = () => Math.random().toString(36).slice(2, 12);

function cleanProducts(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map(p => ({
    id: str(p.id, 30), t: str(p.t, 160), h: str(p.h, 160), sku: (Array.isArray(p.sku) ? p.sku : []).slice(0, 6).map(s => str(s, 40)),
    img: /^https:\/\/(cdn\.shopify\.com|www\.larroude\.com)\//.test(String(p.img || '')) ? str(p.img, 400) : '',
    url: /^https:\/\/www\.larroude\.com\//.test(String(p.url || '')) ? str(p.url, 300) : ''
  })).filter(p => p.id && p.t);
}
function clean(it) {
  return {
    id: /^[a-z0-9]{6,24}$/.test(String(it.id || '')) ? it.id : newId(),
    type: str(it.type, 60).trim(),
    text: str(it.text, 4000),
    tags: (Array.isArray(it.tags) ? it.tags : String(it.tags || '').split(',')).map(s => str(s, 40).trim()).filter(Boolean).slice(0, 12),
    notes: str(it.notes, 1000),
    funnel: FUNNEL.includes(it.funnel) ? it.funnel : '',
    theme: str(it.theme, 40).trim(),
    products: cleanProducts(it.products)
  };
}

// confere o login do Google: token emitido para este site, e-mail verificado e na lista de quem aprova
async function approverOf(idToken) {
  if (!idToken || !CLIENT_ID()) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return null;
  const t = await r.json();
  if (t.aud !== CLIENT_ID()) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) return null;
  if (String(t.email_verified) !== 'true' || Number(t.exp) * 1000 < Date.now()) return null;
  const email = String(t.email || '').toLowerCase();
  return APPROVERS.includes(email) ? { email, name: t.name || email } : { email, name: t.name || email, denied: true };
}

// copys enviadas em lote pelo time (arquivo em data/): entram uma vez, como pendentes
async function withSeed(mk, D) {
  for (const S of SEEDS[mk] || []) D = await applySeed(mk, D, S);
  return D;
}
async function applySeed(mk, D, S) {
  if (!(D.seeded || []).includes(S.version)) {
    let prods = [];
    if (S.product) {
      try {
        const C = await catalog(mk);
        const want = S.product.toLowerCase();
        const p = C.items.find(x => x.t.toLowerCase() === want) || C.items.find(x => x.t.toLowerCase().includes(want));
        if (p) prods = cleanProducts([p]);
      } catch (e) { return D } // loja fora do ar: tenta de novo na próxima visita
    }
    const have = new Set(D.items.map(x => x.id));
    const now = new Date().toISOString();
    const add = S.items.filter(x => !have.has(x.id)).map(x => ({ ...clean({ ...x, type: x.type || S.type, products: prods }), st: 'pending', created: now, by: 'lista enviada pela Jess' }));
    D.items = add.concat(D.items);
    D.seeded = (D.seeded || []).concat(S.version);
    D.updated = now;
    await put('copy:' + mk, D);
  }
  // ajustes posteriores (ex.: etapa do funil sugerida): aplicados uma vez, só onde o campo ainda está vazio
  for (const P of S.patches || []) {
    if ((D.seeded || []).includes(P.version)) continue;
    for (const x of D.items) { const v = P.set[x.id]; if (v) for (const [k, val] of Object.entries(v)) if (!x[k]) x[k] = val }
    D.seeded = (D.seeded || []).concat(P.version); D.updated = new Date().toISOString();
    await put('copy:' + mk, D);
  }
  return D;
}

const pub = (mk, D) => ({ mk, items: D.items.map(x => ({ ...x, st: x.st || 'pending' })), updated: D.updated || null, clientId: CLIENT_ID(), approvers: APPROVERS, funnel: FUNNEL });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      const mk = MKS.includes(q.mk) ? q.mk : 'US';
      let D = (await get('copy:' + mk)) || { items: [], updated: null };
      D = await withSeed(mk, D);
      return res.status(200).json(pub(mk, D));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    const auth = body.auth || { password: body.password };
    // senha só do Banco de copy (COPY_PASSWORD no Vercel); enquanto não existir, vale a do Calendário
    const pass = process.env.COPY_PASSWORD || process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD;
    const who = auth.idToken ? await approverOf(auth.idToken) : null;
    const approver = who && !who.denied ? who : null;
    const team = !!(pass && auth.password && String(auth.password) === pass);
    if (body.action === 'whoami') return res.status(200).json({ email: who ? who.email : null, name: who ? who.name : null, approver: !!approver });
    if (!approver && !team) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ error: auth.idToken ? 'login' : 'senha' }) }
    if (body.action === 'check') return res.status(200).json({ ok: true, approver: !!approver });

    const mk = MKS.includes(body.mk) ? body.mk : 'US';
    const key = 'copy:' + mk;
    const D = (await get(key)) || { items: [] };
    const now = new Date().toISOString();
    const by = approver ? approver.email : 'time';
    const done = async () => { D.updated = now; await put(key, D); return res.status(200).json(pub(mk, D)) };

    if (body.action === 'save' || body.action === 'bulk') {
      // em lote: entra na mesma ordem em que foi colado (cada nova vai para o topo, por isso de trás para frente)
      const list = body.action === 'bulk' ? (Array.isArray(body.items) ? body.items : []).slice(0, 200).reverse() : [body.item || {}];
      for (const raw of list) {
        const it = clean(raw);
        if (!it.text.trim()) continue;
        const i = D.items.findIndex(x => x.id === it.id);
        if (i >= 0) {
          const old = D.items[i];
          // o time mudou uma copy: volta a aguardar aprovação; quem aprova mantém o status
          D.items[i] = { ...old, ...it, st: approver ? (old.st || 'pending') : 'pending', edited: now, editedBy: by };
        } else {
          if (D.items.length >= 3000) return res.status(400).json({ error: 'limite' });
          D.items.unshift({ ...it, st: 'pending', created: now, by });
        }
      }
      return done();
    }
    if (body.action === 'approve' || body.action === 'delete') {
      // remover: quem tem a senha do Banco de copy ou quem aprova. Aprovar: só quem aprova (login Google, ainda não ligado)
      if (body.action === 'approve' && !approver) return res.status(403).json({ error: 'só quem aprova' });
      const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(String));
      if (body.action === 'delete') D.items = D.items.filter(x => !ids.has(x.id));
      else for (const x of D.items) if (ids.has(x.id)) {
        if (body.value === false) { x.st = 'pending'; delete x.approvedBy; delete x.approvedAt }
        else { x.st = 'approved'; x.approvedBy = approver.email; x.approvedAt = now }
      }
      return done();
    }
    res.status(400).json({ error: 'ação' });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
