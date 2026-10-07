/**
 * Larroudé Content Hub — envia as planilhas para o site a cada 10 minutos.
 * Roda com a conta da Jess. Só lê as planilhas, com UMA exceção: quando alguém aprova um criativo
 * no hub, "aplicarAprovacoes" (a cada 1 min) muda a coluna J (status) daquela linha da
 * Creative Request de "Needs approval" / "Jess needs to approve" para "Delivered".
 * Antes de mudar, confere que a linha ainda tem esse status e o mesmo link do Air (ou o mesmo produto/campanha). Nada mais é alterado.
 *
 * Para começar: rode a função "instalar" uma vez (menu ▶ Executar) e autorize.
 */
const SITE = 'https://hub-contentlarroude.vercel.app/api/ingest';
const APROVA = 'https://hub-contentlarroude.vercel.app/api/approve';

const FONTES = {
  criativos:   { id: '1GLgNjLzCqNdRyhB5V8lCh5LDT2VSiVnyXUJZQ0zpUss', gid: 1011478516, colunas: [1, 6, 7, 9, 20, 21, 22] },
  // Brasil: aba "Requisição BR" e a cópia com os pedidos de setembro (mesmo layout)
  criativosBR: { id: '1GLgNjLzCqNdRyhB5V8lCh5LDT2VSiVnyXUJZQ0zpUss', abas: ['Requisição BR', 'Cópia de Requisição BR 4'], colunas: [1, 2, 6, 7, 9, 10, 20, 22] },
  lancamentos: { id: '1hGdtF1oBKs-O0emjFX6YFtfZ9mPiDU100O9ZhXZ--Vg', aba: 'LANÇAMENTOS', colunas: [0, 2, 3, 4, 5, 7, 8] },
  // Social: abas de mês do calendário ("Oct. 2026", "Nov. 2026"...), achadas pelo nome
  socialCal: { id: '1CBE4vnzIG5pb_Bkpr6POLELYK1Je0Zrwh3gKUAwkpfY', meses: true, colunas: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
};

// Lê pela API do Google Sheets com permissão só de leitura
function api(url) {
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error(r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}

function lerAba(f) {
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + f.id;
  let aba = f.aba;
  if (!aba) {
    const meta = Sheets.Spreadsheets.get(f.id, { fields: 'sheets.properties(sheetId,title)' });
    aba = meta.sheets.map(s => s.properties).find(p => p.sheetId === f.gid).title;
  }
  const vals = Sheets.Spreadsheets.Values.get(f.id, "'" + aba + "'").values || [];
  // mantém a posição das colunas, mas só envia as que o site usa
  return vals.map(r => r.map((v, i) => (f.colunas.indexOf(i) >= 0 ? v : '')));
}

// várias abas: junta as linhas preenchidas e guarda o nome da aba (coluna Z) e o número da linha (coluna AA)
function lerAbas(f) {
  let out = [];
  for (const aba of f.abas) {
    let vals = [];
    try { vals = Sheets.Spreadsheets.Values.get(f.id, "'" + aba + "'").values || [] } catch (e) { console.log('aba ' + aba + ': ' + e); continue }
    vals.forEach((r, i) => {
      const linha = r.map((v, j) => (f.colunas.indexOf(j) >= 0 ? v : ''));
      if (!linha.some(v => String(v).trim())) return;
      while (linha.length < 25) linha.push('');
      linha[25] = aba; linha[26] = String(i + 1);
      out.push(linha);
    });
  }
  return out;
}

// abas de mês: nome terminando em ano (ex.: "Oct. 2026")
// (texto de cada célula + os links das células, que o calendário usa: "HERE" → link da peça)
function lerMeses(f) {
  const nomes = Sheets.Spreadsheets.get(f.id, { fields: 'sheets.properties(title)' }).sheets.map(s => s.properties.title).filter(t => /^[A-Za-zçÇ]+\.?\s+20\d\d$/.test(t.trim()));
  if (!nomes.length) return [];
  const ss = Sheets.Spreadsheets.get(f.id, { ranges: nomes.map(n => "'" + n + "'!A1:M200"), fields: 'sheets(properties.title,data.rowData.values(formattedValue,hyperlink,textFormatRuns.format.link.uri))' });
  const out = [];
  for (const sh of ss.sheets) {
    const rd = (sh.data && sh.data[0] && sh.data[0].rowData) || [];
    rd.forEach((r, i) => {
      const vals = r.values || [], links = {};
      const linha = vals.map((v, j) => {
        const u = v.hyperlink || (v.textFormatRuns || []).map(t => t.format && t.format.link && t.format.link.uri).filter(Boolean)[0];
        if (u) links[j] = u;
        return v.formattedValue || '';
      });
      if (!linha.some(v => String(v).trim())) return;
      while (linha.length < 25) linha.push('');
      linha[25] = sh.properties.title; linha[26] = String(i + 1); linha[27] = JSON.stringify(links);
      out.push(linha);
    });
  }
  return out;
}

function enviar() {
  const body = {};
  for (const k in FONTES) {
    try { body[k] = FONTES[k].meses ? lerMeses(FONTES[k]) : FONTES[k].abas ? lerAbas(FONTES[k]) : lerAba(FONTES[k]) }
    catch (e) { console.log(k + ': ' + e); if (!FONTES[k].meses) throw e }
  }
  const r = UrlFetchApp.fetch(SITE, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  console.log(r.getResponseCode() + ' ' + r.getContentText());
}

// Aprovações feitas no hub → coluna J da Creative Request vira "Delivered"
function aplicarAprovacoes() {
  const auth = { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() };
  const r = UrlFetchApp.fetch(APROVA + '?queue=1', { headers: auth, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { console.log('fila: ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200)); return }
  const fila = JSON.parse(r.getContentText()).items || [];
  if (!fila.length) return;
  const id = FONTES.criativos.id;
  let abaUS = null;
  const done = [];
  for (const a of fila) {
    try {
      let aba = a.tab;
      if (a.mk === 'US' || !aba) {
        if (!abaUS) abaUS = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' }).sheets.map(s => s.properties).find(p => p.sheetId === FONTES.criativos.gid).title;
        aba = abaUS;
      }
      if (a.mk === 'BR' && FONTES.criativosBR.abas.indexOf(aba) < 0) { done.push({ k: a.k, ok: false, msg: 'aba desconhecida' }); continue }
      const lin = Sheets.Spreadsheets.Values.get(id, "'" + aba + "'!A" + a.row + ':U' + a.row).values || [[]];
      const v = lin[0] || [];
      const status = String(v[9] || ''), link = String(v[20] || '');
      if (!/needs approval|needs to approve/i.test(status)) { done.push({ k: a.k, ok: /delivered/i.test(status), msg: status ? 'status atual: ' + status : 'linha vazia' }); continue }
      const ref = a.ref || (a.sid ? '/b/' + a.sid : '');
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
      const fpOk = a.fp && norm(a.mk === 'BR' ? (v[10] || v[1]) : v[1]).slice(0, 60) === a.fp;
      if (ref ? link.indexOf(ref) < 0 : !fpOk) { done.push({ k: a.k, ok: false, msg: 'a linha mudou de lugar na planilha' }); continue }
      Sheets.Spreadsheets.Values.update({ values: [['Delivered']] }, id, "'" + aba + "'!J" + a.row, { valueInputOption: 'USER_ENTERED' });
      done.push({ k: a.k, ok: true });
    } catch (e) { done.push({ k: a.k, ok: false, msg: String(e).slice(0, 150) }) }
  }
  UrlFetchApp.fetch(APROVA, { method: 'post', contentType: 'application/json', headers: auth, payload: JSON.stringify({ action: 'ack', done }), muteHttpExceptions: true });
  console.log(JSON.stringify(done));
  if (done.some(d => d.ok)) enviar(); // o site já recebe a planilha atualizada
}

function instalar() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enviar').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('aplicarAprovacoes').timeBased().everyMinutes(1).create();
  enviar();
}
