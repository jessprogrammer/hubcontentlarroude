// Aprovação de ADS pelo Asana (substitui a Creative Request).
// Fonte: tarefas de ADS do projeto [MKT] Content Team/Marketing (campo Category = Ads), exceto COPY.
// Um criativo entra em "Para aprovar" quando o link da pasta do Air é comentado na tarefa
// (cada subpasta da pasta vira um card). Aprovar/reprovar no hub:
//   - comenta na tarefa: "✅ Aprovado no hub por <nome>: <criativo>" / "❌ Reprovado no hub por <nome>: <criativo> — Motivo: …"
//   - quando todos os criativos daquela entrega foram decididos, muda o campo Status da tarefa:
//     todos aprovados → "Aprovado"; algum reprovado → "Reprovado" (a opção é criada se não existir) e a tarefa volta a ficar aberta.
// O próprio Asana guarda as decisões (os comentários do hub), então o hub não precisa de outro banco para saber o que já foi decidido.
//   GET  /api/approve?src=asana[&refresh=1]  → { updated, items }
//   POST /api/approve?src=asana { task, unit, units, label, dec:'ok'|'no', msg, who }
import { get, put } from './store.js';
import { pool, getJSON, iso } from './util.js';
import { crawl, clips, category, normName } from '../api/air.js';

const API = 'https://app.asana.com/api/1.0';
const WS = '1199941711767564', PROJECT = '1203331193070474';
const F_CAT = '1214226414382660', O_ADS = '1214226414382661';
const F_STATUS = '1210250542600640', O_APROVADO = '1210250542600703';
const KEY = 'adsq:v2', FRESH = 3 * 60e3;
const AIR_SHORT = 'https://api.air.inc/shorturl/';
const WD = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function token() {
  let v = String(process.env.ASANA_TOKEN || process.env.ASANA_ACCESS_TOKEN || '').trim();
  return v.replace(/^[A-Z_]+\s*=\s*/, '').replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}
const redact = s => String(s || '').replace(/[A-Za-z0-9_:\/-]{24,}/g, '[…]');
async function asana(path, opt = {}) {
  for (let k = 0; k < 4; k++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(API + path, { ...opt, headers: { Authorization: 'Bearer ' + token(), Accept: 'application/json', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) }, signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 1500 * (k + 1))); continue }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Asana ' + r.status + ' ' + redact(((j.errors || [])[0] || {}).message || '').slice(0, 160));
      return j;
    } finally { clearTimeout(t) }
  }
  throw new Error('Asana ocupado, tente de novo');
}

// links de pasta do Air num comentário
//   https://app.air.inc/a/<código>                 → pasta compartilhada
//   https://app.air.inc/a/<código>/b/<uuid>        → subpasta dentro da compartilhada
const LINK = /https?:\/\/app\.air\.inc\/a\/([0-9a-z]{6,12})(?:\/b\/(?:[a-z0-9-]*?-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?/gi;
const DEC = /^(✅|❌)\s*(Aprovado|Reprovado) no hub/;

const mkOf = name => /^ADS_US-BR|^ADS_BR-US/i.test(name) ? 'US-BR' : /^ADS_BR/i.test(name) ? 'BR' : 'US';
const campOf = name => String(name).replace(/^ADS_[A-Z-]+\s*-\s*/i, '').replace(/\s*-\s*(BRIEF|DESIGN|VIDEO|COPY)\b.*$/i, '').trim();
const kindOf = name => ((String(name).match(/-\s*(BRIEF|DESIGN|VIDEO)\b/i) || [])[1] || '').toUpperCase();

async function adsTasks() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const opt = 'name,completed,permalink_url,parent.name,custom_fields.gid,custom_fields.enum_value.gid,custom_fields.enum_value.name,modified_at';
  let out = [], before = '';
  for (let n = 0; n < 4; n++) {
    const q = new URLSearchParams({ 'projects.any': PROJECT, ['custom_fields.' + F_CAT + '.value']: O_ADS, 'modified_at.after': since, sort_by: 'modified_at', limit: '100', opt_fields: opt });
    if (before) q.set('modified_at.before', before);
    const j = await asana('/workspaces/' + WS + '/tasks/search?' + q.toString());
    const d = j.data || [];
    out = out.concat(d);
    if (d.length < 100) break;
    before = d[d.length - 1].modified_at;
  }
  const seen = new Set();
  return out.filter(t => !seen.has(t.gid) && seen.add(t.gid) && /^ADS_/i.test(t.name) && !/-\s*COPY\b/i.test(t.name));
}

async function stories(gid) {
  const j = await asana('/tasks/' + gid + '/stories?limit=100&opt_fields=created_at,created_by.name,text,resource_subtype');
  return (j.data || []).filter(s => s.resource_subtype === 'comment_added' && s.text);
}

// pasta do Air → criativos (as subpastas finais; se a pasta não tiver subpastas, ela mesma é o criativo)
async function creatives(sc, sub) {
  let root = sub, title = '';
  if (!root) {
    const j = await getJSON(AIR_SHORT + sc, {}, 2);
    if (!(j && j.type === 'board' && j.data && j.data.id)) return [];
    root = j.data.id; title = (j.data.title || '').trim();
  }
  const slim = L => ({ id: L.id, path: L.path, anc: (L.anc || []).map(a => String(a).slice(0, 8)), sc, clips: L.clips.map(c => ({ ext: c.ext, width: c.width, height: c.height, duration: c.duration, importedName: c.importedName || c.title || c.displayName, assets: { image: c.assets && c.assets.image } })) });
  const leaves = await crawl({ shortcode: sc, root, name: '' });
  if (leaves.length) return leaves.map(slim);
  // pasta sem subpastas: os arquivos estão direto nela
  const c = await clips(sc, root);
  return c.length ? [slim({ id: root, path: title ? [title] : [], clips: c })] : [];
}

async function build() {
  const tasks = await adsTasks();
  const withS = await pool(tasks, 6, async t => ({ t, s: await stories(t.gid).catch(() => []) }));
  const items = [], AIRC = (await get('adsq:air2').catch(() => null)) || {};
  const t0 = Date.now(); let crawled = 0;
  // TRANSIÇÃO (a Creative Request foi abolida em 23/11/2026): de tudo que foi comentado no Asana antes da troca,
  // tudo já estava resolvido; só o que for comentado depois da troca pede aprovação.
  const CUT = '2026-11-23T13:05:00Z';
  const SEED = new Set(); // 23/11: a Jess confirmou que os pendentes de antes da troca já estavam aprovados
  const jobs = [];
  for (const { t, s } of withS) {
    const decided = {};
    for (const c of s) {
      const m = c.text.match(DEC);
      if (!m) continue;
      // "✅ Aprovado no hub por Marina: Creative 1 [ab12cd34]"
      const u = (c.text.match(/\[([0-9a-f]{8})\]/) || [])[1];
      if (u) decided[u] = { dec: m[2] === 'Aprovado' ? 'ok' : 'no', at: c.created_at, by: (c.text.match(/no hub por ([^:]+):/) || [])[1] || '', note: (c.text.match(/Motivo:\s*([\s\S]*)$/) || [])[1] || '' };
    }
    for (const c of s) {
      if (DEC.test(c.text)) continue;
      for (const m of c.text.matchAll(LINK)) jobs.push({ t, c, sc: m[1].toLowerCase(), sub: m[2] || '', decided });
    }
  }
  // cada link uma vez por tarefa (o mais recente vale)
  const uniq = new Map();
  for (const j of jobs) { const k = j.t.gid + '|' + j.sc + '|' + j.sub; if (!uniq.has(k) || uniq.get(k).c.created_at < j.c.created_at) uniq.set(k, j) }
  await pool([...uniq.values()], 4, async j => {
    // pastas do Air ficam guardadas por 20 min (a função tem no máximo 60 s)
    const ck = j.sc + '|' + j.sub, hit = AIRC[ck];
    let leaves = hit ? hit.l : [];
    if (!hit || Date.now() - hit.at > 20 * 60e3) {
      if (Date.now() - t0 > 35e3 || crawled >= 30) { if (!hit) return } else {
        crawled++;
        try { leaves = await creatives(j.sc, j.sub); AIRC[ck] = { at: Date.now(), l: leaves } } catch (e) { if (!hit) return }
      }
    }
    const st = (j.t.custom_fields || []).find(f => f.gid === F_STATUS);
    const status = st && st.enum_value ? st.enum_value.name : '';
    const d = new Date(Date.parse(j.c.created_at) - 3 * 3600e3);
    for (const L of leaves) {
      const bid = String(L.id).slice(0, 8);
      const dec = j.decided[bid];
      // decisão mais antiga que o link = entrega nova (refação): volta a pedir aprovação
      let valid = dec && dec.at >= j.c.created_at ? dec : null;
      if (!valid && j.c.created_at < CUT && !SEED.has(j.t.gid + '#' + bid)) valid = { dec: 'ok', by: 'antes da troca para o Asana', note: '', at: j.c.created_at };
      const exts = [...new Set(L.clips.map(c => c.ext))];
      const sq = L.clips.find(c => c.width === c.height) || L.clips[0];
      items.push({
        src: 'asana', task: j.t.gid, taskName: j.t.name, taskUrl: j.t.permalink_url, kind: kindOf(j.t.name), status,
        mk: mkOf(j.t.name), date: iso(d), dd: iso(d).slice(8) + '/' + iso(d).slice(5, 7), wd: WD[(d.getUTCDay() + 6) % 7],
        camp: campOf(j.t.name) || '—', detail: L.path.join(' / ') || '—', bid,
        cat: category(L.path, L.clips.length, exts, null), obj: '', fun: '',
        dec: valid ? valid.dec : '', by: valid ? valid.by : '', note: valid ? valid.note : '', decAt: valid ? valid.at : '',
        linkAt: j.c.created_at, linkBy: (j.c.created_by && j.c.created_by.name) || '',
        n: L.clips.length, dur: Math.round(Math.max(0, ...L.clips.map(c => c.duration || 0))),
        link: `https://app.air.inc/a/${L.sc || j.sc}/b/${L.id}`,
        img: sq && sq.assets && sq.assets.image ? sq.assets.image + '?w=440&h=440&fit=crop&auto=format&q=75' : '',
        files: L.clips.map(c => normName(c.importedName || c.title || c.displayName)).filter(Boolean), fx: exts,
      });
    }
  });
  items.sort((a, b) => b.linkAt.localeCompare(a.linkAt));
  // a mesma pasta do Air comentada em mais de uma tarefa (ex.: BRIEF, DESIGN e VIDEO): um card só,
  // ligado à subtarefa (DESIGN/VIDEO) mais recente; a BRIEF só fica quando é a única
  const rank = x => (x.kind === 'BRIEF' || !x.kind ? 1 : 0);
  const best = new Map();
  for (const x of items) { const o = best.get(x.bid); if (!o || rank(x) < rank(o) || (rank(x) === rank(o) && x.linkAt > o.linkAt)) best.set(x.bid, x) }
  items.splice(0, items.length, ...[...best.values()].sort((a, b) => b.linkAt.localeCompare(a.linkAt)));
  // guarda só as pastas ainda citadas
  const keep = {}; for (const k of uniq.keys()) { const [, sc, sub] = k.split('|'); if (AIRC[sc + '|' + sub]) keep[sc + '|' + sub] = AIRC[sc + '|' + sub] }
  await put('adsq:air2', keep).catch(() => {});
  return { updated: new Date().toISOString(), items };
}

async function listAll(refresh) {
  const c = await get(KEY).catch(() => null);
  if (c && !refresh && Date.now() - Date.parse(c.updated) < FRESH) return c;
  const d = await build();
  await put(KEY, d);
  return d;
}

// opção "Reprovado" no campo Status (criada uma vez se não existir)
async function statusOption(name) {
  if (name === 'Aprovado') return O_APROVADO;
  const cache = await get('adsq:opt').catch(() => null);
  if (cache && cache[name]) return cache[name];
  const f = await asana('/custom_fields/' + F_STATUS + '?opt_fields=enum_options.name,enum_options.gid,enum_options.enabled');
  let o = (f.data.enum_options || []).find(x => x.name.toLowerCase() === name.toLowerCase() && x.enabled);
  if (!o) o = (await asana('/custom_fields/' + F_STATUS + '/enum_options', { method: 'POST', body: JSON.stringify({ data: { name, color: 'red' } }) })).data;
  await put('adsq:opt', { ...(cache || {}), [name]: o.gid });
  return o.gid;
}

async function decide(body) {
  const task = /^\d{6,20}$/.test(String(body.task || '')) ? String(body.task) : '';
  const unit = /^[0-9a-f]{8}$/i.test(String(body.unit || '')) ? String(body.unit).toLowerCase() : '';
  if (!task || !unit) throw Object.assign(new Error('criativo'), { code: 400 });
  const dec = body.dec === 'no' ? 'no' : 'ok';
  const msg = str(body.msg, 1000).trim();
  if (dec === 'no' && !msg) throw Object.assign(new Error('motivo'), { code: 400 });
  const who = str(body.who, 40).replace(/[\[\]:]/g, '').trim() || 'alguém';
  const label = str(body.label, 120).replace(/[\[\]]/g, '').trim() || 'criativo';
  const units = [...new Set((Array.isArray(body.units) ? body.units : []).map(u => String(u).toLowerCase()).filter(u => /^[0-9a-f]{8}$/.test(u)))].slice(0, 60);
  if (!units.includes(unit)) units.push(unit);
  const text = (dec === 'ok' ? '✅ Aprovado no hub por ' : '❌ Reprovado no hub por ') + who + ': ' + label + ' [' + unit + ']' + (dec === 'no' ? '\nMotivo: ' + msg : '');
  await asana('/tasks/' + task + '/stories', { method: 'POST', body: JSON.stringify({ data: { text } }) });
  // atualiza o que o hub já sabe e vê se a entrega inteira foi decidida
  const D = await get(KEY).catch(() => null);
  let closed = false, final = '';
  if (D && D.items) {
    const now = new Date().toISOString();
    for (const x of D.items) if (x.task === task && x.bid === unit) Object.assign(x, { dec, by: who, note: dec === 'no' ? msg : '', decAt: now });
    const mine = D.items.filter(x => x.task === task && units.includes(x.bid));
    if (mine.length && mine.every(x => x.dec)) {
      closed = true;
      final = mine.some(x => x.dec === 'no') ? 'Reprovado' : 'Aprovado';
    }
    await put(KEY, D);
  } else if (units.length === 1) { closed = true; final = dec === 'no' ? 'Reprovado' : 'Aprovado' }
  if (closed) {
    const data = { custom_fields: { [F_STATUS]: await statusOption(final) } };
    if (final === 'Reprovado') data.completed = false; // volta para o designer
    await asana('/tasks/' + task, { method: 'PUT', body: JSON.stringify({ data }) });
  }
  return { ok: true, closed, final };
}

export default async function adsAsana(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!token()) return res.status(503).json({ error: 'ASANA_TOKEN não configurado' });
    if (req.method === 'GET') return res.status(200).json(await listAll(req.query && req.query.refresh === '1'));
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    return res.status(200).json(await decide(body || {}));
  } catch (e) { res.status(e.code || 502).json({ error: String(e.message || e).slice(0, 200) }) }
}
