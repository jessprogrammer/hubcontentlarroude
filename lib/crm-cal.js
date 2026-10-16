// Calendário de CRM (planilha "2026 CRM/Email calendar", abas "US - OUT", "BRA - OUT"...), servido por /api/calendar?src=crm.
// (fica dentro do /api/calendar porque o plano do Vercel aceita no máximo 12 funções)
// A planilha é só lida: o Apps Script manda as abas a cada poucos minutos (chave "crm" no /api/ingest).
// Cada aba tem blocos por semana: linha DAY (datas nas colunas B–H) e as linhas de canal (EMAIL, SMS, WHATSAPP, POPUP, FOOTER…);
// a linha HORÁRIO logo abaixo de um canal é o horário daquele canal. Colunas depois da H são anotações e ficam de fora.
// "Ação geral" e "Ads" não existem na planilha: são preenchidos no hub (senha do Banco de copy).
// Ação geral é um período (de/até, ex.: 16 a 28); Ads é por dia.
// GET                                              → { updated, items:[{mk,d,ch,t,h}], hub:{ 'US|2026-10-20': {ads} }, actions:[{id,mk,from,to,t}], channels }
// POST { password, action:'check' }
// POST { password, action:'save', mk, d, ads }                 → grava os Ads do dia
// POST { password, action:'saveAction', id?, mk, from, to, t } → cria ou edita uma Ação geral
// POST { password, action:'deleteAction', id }                 → apaga uma Ação geral
import { get, put } from './store.js';

const HUB = 'crm:hub';
const isoOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const newId = () => Math.random().toString(36).slice(2, 12);
// versão antiga guardava a ação por dia: vira um período de um dia só
function upgrade(H) {
  H = H || { days: {} };
  H.days = H.days || {};
  if (!Array.isArray(H.actions)) {
    H.actions = [];
    for (const [k, v] of Object.entries(H.days)) {
      if (v && v.acao) { const [mk, d] = k.split('|'); H.actions.push({ id: newId(), mk, from: d, to: d, t: v.acao, at: v.at || '' }) }
    }
  }
  for (const [k, v] of Object.entries(H.days)) { if (v) delete v.acao; if (!v || !v.ads) delete H.days[k] }
  return H;
}
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const pass = () => process.env.COPY_PASSWORD || process.env.CAL_PASSWORD || process.env.TEAM_PASSWORD || '';
const pad = n => String(n).padStart(2, '0');
const MON = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
const YEAR = 2026; // a planilha é a de 2026
export const CHANNELS = ['acao', 'email', 'email2', 'sms', 'wpp', 'social', 'ads', 'popup', 'footer'];
function chOf(label) {
  const s = String(label || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  if (!s) return '';
  if (s === 'email2nd' || s === 'email2') return 'email2';
  if (s.startsWith('email')) return 'email';
  if (s === 'sms') return 'sms';
  if (s.startsWith('whats') || s === 'wpp') return 'wpp';
  if (s.startsWith('popup')) return 'popup';
  if (s.startsWith('footer')) return 'footer';
  if (s.startsWith('horario')) return 'time';
  if (s === 'day' || s === 'dia') return 'day';
  return 'x';
}
// "US - OUT" / "BRA - OUT" → { mk, m }
function tabInfo(t) {
  const m = String(t || '').trim().match(/^(US|BRA?)\s*-\s*([A-Za-zÇç]{3})/i);
  if (!m) return null;
  const mo = MON[m[2].toLowerCase()];
  return mo ? { mk: m[1].toUpperCase() === 'US' ? 'US' : 'BR', m: mo } : null;
}
// "September 28" (+ mês da aba) → "2026-09-28"
function dateOf(v, tabM) {
  const m = String(v || '').trim().match(/^([A-Za-zÇç]+)\.?\s+(\d{1,2})/);
  if (!m) return '';
  const mo = MON[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return '';
  let y = YEAR;
  if (tabM === 1 && mo === 12) y--; else if (tabM === 12 && mo === 1) y++;
  return y + '-' + pad(mo) + '-' + pad(+m[2]);
}

export function parse(rows) {
  const out = new Map();
  let tab = '', info = null, dates = [], lastCh = '';
  for (const r of rows || []) {
    if (r[25] !== tab) { tab = r[25]; info = tabInfo(tab); dates = []; lastCh = '' }
    if (!info) continue;
    const ch = chOf(r[0]);
    if (ch === 'day') { dates = [1, 2, 3, 4, 5, 6, 7].map(c => dateOf(r[c], info.m)); lastCh = ''; continue }
    if (!dates.length) continue;
    if (ch === 'time') {
      if (!lastCh) continue;
      for (let c = 1; c <= 7; c++) {
        const h = str(r[c], 40).trim(); if (!h || !dates[c - 1]) continue;
        for (const it of out.values()) if (it.mk === info.mk && it.d === dates[c - 1] && it.ch === lastCh && !it.h) it.h = h;
      }
      continue;
    }
    const use = ch === '' ? lastCh : ch === 'x' ? '' : ch; // linha sem nome logo abaixo de um canal = continuação dele
    if (!use) continue;
    lastCh = use;
    for (let c = 1; c <= 7; c++) {
      const t = str(r[c], 300).replace(/\s+/g, ' ').trim(), d = dates[c - 1];
      if (!t || !d || /^\d{1,2}(:\d{2})?\s*(am|pm|h)?$/i.test(t)) continue; // horário solto numa linha de canal
      const k = info.mk + '|' + d + '|' + use + '|' + t.toLowerCase();
      if (!out.has(k)) out.set(k, { mk: info.mk, d, ch: use, t, h: '' });
    }
  }
  return [...out.values()].sort((a, b) => a.d.localeCompare(b.d) || CHANNELS.indexOf(a.ch) - CHANNELS.indexOf(b.ch));
}

export default async function crmCal(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const [doc, H0] = await Promise.all([get('sheet:crm'), get(HUB)]);
      const H = upgrade(H0);
      return res.status(200).json({ updated: doc ? doc.updated : null, items: parse(doc ? doc.rows : []), hub: H.days, actions: H.actions, channels: CHANNELS });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    if (!pass() || String(body.password || '') !== pass()) return res.status(401).json({ error: 'senha' });
    if (body.action === 'check') return res.status(200).json({ ok: true });
    const H = upgrade(await get(HUB));
    const mk = body.mk === 'BR' ? 'BR' : body.mk === 'US' ? 'US' : '';
    const now = new Date().toISOString();
    if (body.action === 'saveAction') {
      const from = isoOk(body.from) ? body.from : '', to = isoOk(body.to) ? body.to : from, t = str(body.t, 300).trim();
      if (!mk || !from || !t) return res.status(400).json({ error: 'mercado, data e texto' });
      const it = { mk, from: to < from ? to : from, to: to < from ? from : to, t, at: now };
      const old = H.actions.find(a => a.id === String(body.id || ''));
      if (old) Object.assign(old, it); else { if (H.actions.length >= 1000) return res.status(400).json({ error: 'limite' }); H.actions.push({ id: newId(), ...it }) }
    } else if (body.action === 'deleteAction') {
      H.actions = H.actions.filter(a => a.id !== String(body.id || ''));
    } else if (body.action === 'save') {
      const d = isoOk(body.d) ? body.d : '';
      if (!mk || !d) return res.status(400).json({ error: 'mercado e data' });
      const k = mk + '|' + d, ads = str(body.ads, 600).trim();
      if (ads) H.days[k] = { ads, at: now }; else delete H.days[k];
      if (Object.keys(H.days).length > 3000) return res.status(400).json({ error: 'limite' });
    } else return res.status(400).json({ error: 'ação' });
    H.updated = now;
    await put(HUB, H);
    res.status(200).json({ ok: true, hub: H.days, actions: H.actions });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 200) }) }
}
