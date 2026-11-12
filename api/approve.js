// /api/approve — aprovar criativos do Entregas pelo hub.
// GET                         → { items } aprovações recentes (o site mostra o card como Delivered na hora)
// POST { mk, tab, row, sid, camp }  → entra na fila (sem senha)
// POST { ..., dec:'no', msg }                 → reprovar: o status vira "Needs to be edit" e o motivo (obrigatório) vira nota na célula de status
// O Apps Script da Jess (a cada 1 min) busca a fila e muda só a coluna de status (J) para "Delivered",
// conferindo antes que a linha ainda está "Needs approval" e que o link do Air é o mesmo.
//   GET  ?queue=1  (token do Google do script)  → { items: pendentes }
//   POST { action:'ack', done:[{k, ok, msg}] } (token do Google do script)
import config from '../config.js';
import { get, put } from '../lib/store.js';
import banners from '../lib/banners.js';

const KEY = 'appr:v1';
const NEEDS = /needs approval|needs to approve/i;
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

async function scriptEmail(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok));
  if (!r.ok) return null;
  const t = await r.json();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || String(t.email_verified) !== 'true') return null;
  const email = String(t.email || '').toLowerCase();
  return config.ingestEmails.map(e => e.toLowerCase()).includes(email) ? email : null;
}

// linhas da Creative Request com status de aprovação. US: aba "US Request - Meta" (sem nome de aba). BR: abas lidas pelo script.
// Colunas: B(1) peça, C(2) tipo, G(6) objetivo, J(9) status, K(10) produto/campanha (só BR), U(20) link do Air, W(22) entrega
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
export const fpOf = (mk, r) => norm(mk === 'BR' ? (r[10] || r[1]) : r[1]).slice(0, 60);
async function needRows(mk) {
  const doc = await get(mk === 'BR' ? 'sheet:criativosBR' : 'sheet:criativos');
  if (!doc) return [];
  const out = [];
  doc.rows.forEach((r, i) => {
    if (!NEEDS.test(String(r[9] || ''))) return;
    const row = r[26] ? +r[26] : i + 1, tab = mk === 'BR' ? (r[25] || '') : '';
    const link = String(r[20] || '');
    const bm = link.match(/\/b\/((?:[a-z0-9-]*?-)?)([0-9a-f]{8})-[0-9a-f]{4}-/i);
    const sid = bm ? bm[2].toLowerCase() : '';
    const sc = (link.match(/app\.air\.inc\/a\/([0-9a-z]{6,12})/i) || [])[1] || '';
    const air = (link.match(/https:\/\/app\.air\.inc\/[^\s,;]+/) || [])[0] || '';
    out.push({ k: mk + '|' + tab + '|' + row, mk, tab, row, st: String(r[9]).trim(), peca: str(r[1], 160), tipo: str(r[2], 60), obj: str(r[6], 40),
      camp: mk === 'BR' ? str(r[10], 200) : '', date: str(r[22], 20), air, sid, ref: bm ? '/b/' + bm[1] + bm[2] : sc ? '/a/' + sc : '', fp: fpOf(mk, r) });
  });
  return out;
}

// Aviso no Slack (canal #calendário-e-tarefas-content) com o que acabou de ser aplicado na planilha.
// env SLACK_APROVACOES_WEBHOOK = link do fluxo do Workflow Builder, com uma variável de texto "mensagem".
const HUB = 'https://hub-contentlarroude.vercel.app/#entregas';
async function avisar(list) {
  const hook = process.env.SLACK_APROVACOES_WEBHOOK;
  if (!hook || !list.length) return 'off';
  const nome = x => (String(x.camp || '').replace(/\s+/g, ' ').trim() || 'Criativo') + ' (linha ' + x.row + (x.mk === 'BR' ? ', BR' : '') + ')';
  const ok = list.filter(x => x.dec !== 'no'), no = list.filter(x => x.dec === 'no');
  const partes = [];
  if (ok.length) partes.push('✅ Aprovados no hub · Entregas Meta\n' + ok.map(x => '• ' + nome(x)).join('\n') + '\nJá estão como Delivered na planilha.');
  if (no.length) partes.push('❌ Reprovados no hub · Entregas Meta\n' + no.map(x => '• ' + nome(x) + ': ' + (x.note || 'sem motivo')).join('\n') + '\nJá estão como Needs to be edit na planilha, com o motivo na nota da célula de status.');
  const mensagem = partes.join('\n\n') + '\n\nVer no hub: ' + HUB;
  try {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mensagem }) });
    return r.ok ? 'ok' : 'erro ' + r.status;
  } catch (e) { return 'erro' }
}

const load = async () => (await get(KEY)) || { items: {} };
// guarda só os últimos 14 dias
function prune(D) {
  const lim = Date.now() - 14 * 864e5;
  for (const [k, x] of Object.entries(D.items)) if (x.st !== 'pending' && Date.parse(x.at) < lim) delete D.items[k];
  for (const [k, g] of Object.entries(D.units || {})) if (Date.parse(g.at) < lim && !(D.items[k] && D.items[k].st === 'pending')) delete D.units[k];
  return D;
}

// Uma linha da planilha com vários criativos (subpastas no Air, ex.: "Anne Boot / Creative 1" e "Creative 2"):
// cada criativo é decidido no hub separado (D.units[linha].d[subpasta]). A planilha só muda quando TODOS
// os criativos da linha foram decididos: todos aprovados → Delivered; algum reprovado → Needs to be edit,
// com a nota dizendo qual criativo e o motivo.
function closeUnits(D, k) {
  const g = D.units && D.units[k];
  if (!g || g.exp.some(u => !g.d[u])) return false;
  const L = g.exp.map(u => g.d[u]);
  const no = L.filter(x => x.dec === 'no'), ok = L.filter(x => x.dec !== 'no');
  const lab = x => x.label || 'Criativo';
  const note = no.length ? no.map(x => lab(x) + ': ' + x.note).concat(ok.length ? ['Aprovados: ' + ok.map(lab).join(', ')] : []).join('\n').slice(0, 500) : '';
  D.items[k] = { k, mk: g.mk, tab: g.tab, row: g.row, sid: g.sid, ref: g.ref, fp: g.fp, camp: g.camp, from: g.from, dec: no.length ? 'no' : 'ok',
    to: no.length ? 'Needs to be edit' : 'Delivered', note, units: g.exp.length, st: 'pending', at: new Date().toISOString() };
  return true;
}

// a linha voltou para "Needs approval" na planilha DEPOIS que a decisão foi aplicada (alguém reabriu):
// a decisão antiga deixa de valer e os criativos aparecem de novo para aprovar
async function reopen(D) {
  const ups = {}, need = new Set();
  for (const mk of ['US', 'BR']) {
    const doc = await get(mk === 'BR' ? 'sheet:criativosBR' : 'sheet:criativos');
    ups[mk] = doc ? Date.parse(doc.updated) || 0 : 0;
    (await needRows(mk)).forEach(x => need.add(x.k));
  }
  let ch = false;
  for (const [k, x] of Object.entries(D.items)) {
    if (x.st !== 'done' || !need.has(k)) continue;
    if (ups[x.mk || 'US'] > Date.parse(x.doneAt || x.at) + 3 * 60e3) { delete D.items[k]; if (D.units) delete D.units[k]; ch = true }
  }
  if (ch) await put(KEY, D);
  return D;
}

export default async function handler(req, res) {
  // Banners Home (aprovação livre da Marina), no mesmo endpoint por causa do limite de 12 funções
  if (req.query && req.query.src === 'banners') return banners(req, res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      if (q.queue) {
        if (!(await scriptEmail(req))) return res.status(401).json({ error: 'não autorizado' });
        const D = await load();
        // ?queue=2 = script novo (sabe reprovar). O script antigo (?queue=1) só recebe aprovações, para nunca marcar uma reprovação como Delivered.
        const novo = String(q.queue) === '2';
        return res.status(200).json({ items: Object.values(D.items).filter(x => x.st === 'pending' && (novo || x.dec !== 'no')) });
      }
      const D = await reopen(await load());
      const out = { items: Object.values(D.items).map(({ k, mk, st, at, msg, dec, note }) => ({ k, mk, st, at, msg, dec: dec || 'ok', note: note || '' })) };
      // decisões por criativo (linhas com vários criativos), k = "<linha>#<subpasta>"
      out.units = [];
      for (const g of Object.values(D.units || {})) for (const [u, x] of Object.entries(g.d)) out.units.push({ k: g.k + '#' + u, dec: x.dec, note: x.note || '', at: x.at, left: g.exp.filter(v => !g.d[v]).length });
      // lista "Para aprovar": todas as linhas da planilha com status de aprovação, mesmo sem criativo achado no Air
      if (q.list) out.need = (await needRows('US')).concat(await needRows('BR'));
      return res.status(200).json(out);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }

    if (body.action === 'ack') {
      if (!(await scriptEmail(req))) return res.status(401).json({ error: 'não autorizado' });
      const D = await load();
      const applied = [];
      for (const d of (Array.isArray(body.done) ? body.done : [])) {
        const x = D.items[str(d.k, 200)];
        if (x && x.st === 'pending') { x.st = d.ok ? 'done' : 'error'; x.msg = str(d.msg, 200); x.doneAt = new Date().toISOString(); if (d.ok) applied.push(x) }
      }
      await put(KEY, prune(D));
      const slack = await avisar(applied);
      return res.status(200).json({ ok: true, slack });
    }

    // aprovar / reprovar: livre, sem senha (pedido da Jess — quem aprova não vai lembrar de senha)
    const mk = body.mk === 'BR' ? 'BR' : 'US';
    const row = parseInt(body.row, 10), tab = str(body.tab, 100), sid = str(body.sid, 8);
    const fp = str(body.fp, 60);
    // ref: o pedaço do link do Air que está na planilha ("/b/<id>" ou "/a/<código>"); o script confere antes de mudar
    const ref = /^\/(b\/(?:[a-z0-9-]*-)?[0-9a-f]{8}|a\/[0-9a-z]{6,12})$/i.test(String(body.ref || '')) ? String(body.ref) : (/^[0-9a-f]{8}$/.test(sid) ? '/b/' + sid : '');
    if (!(row > 1) || !(ref || fp)) return res.status(400).json({ error: 'linha' });
    if (!NEEDS.test(String(body.st || ''))) return res.status(400).json({ error: 'status' });
    const dec = body.dec === 'no' ? 'no' : 'ok';
    const note = dec === 'no' ? str(body.msg, 500).trim() : '';
    if (dec === 'no' && !note) return res.status(400).json({ error: 'motivo' });
    const k = mk + '|' + tab + '|' + row;
    const D = prune(await load());
    const unit = /^[0-9a-f]{8}$/i.test(String(body.unit || '')) ? String(body.unit).toLowerCase() : '';
    const units = [...new Set((Array.isArray(body.units) ? body.units : []).map(u => String(u).toLowerCase()).filter(u => /^[0-9a-f]{8}$/.test(u)))].slice(0, 40);
    if (unit && units.length > 1 && units.includes(unit)) {
      if (D.items[k] && D.items[k].st === 'pending') return res.status(409).json({ error: 'linha já decidida' });
      D.units = D.units || {};
      const now = new Date().toISOString();
      const g = D.units[k] = D.units[k] || { k, mk, tab, row, sid, ref, fp, camp: str(body.camp, 120), from: str(body.st, 60), exp: [], d: {}, at: now };
      g.exp = [...new Set(g.exp.concat(units))].slice(0, 40);
      g.d[unit] = { dec, note, label: str(body.label, 80), at: now };
      g.at = now;
      const fechou = closeUnits(D, k);
      await put(KEY, D);
      return res.status(200).json({ ok: true, k, unit, closed: fechou, left: g.exp.filter(u => !g.d[u]).length });
    }
    D.items[k] = { k, mk, tab, row, sid, ref, fp, camp: str(body.camp, 120), from: str(body.st, 60), dec, to: dec === 'no' ? 'Needs to be edit' : 'Delivered', note, st: 'pending', at: new Date().toISOString() };
    await put(KEY, D);
    res.status(200).json({ ok: true, k });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
