/**
 * Larroudé Content Hub — envia as planilhas para o site a cada 10 minutos.
 * Roda com a conta da Jess (só leitura nas planilhas). Nada é alterado nelas.
 *
 * Para começar: rode a função "instalar" uma vez (menu ▶ Executar) e autorize.
 */
const SITE = 'https://hub-contentlarroude.vercel.app/api/ingest';

const FONTES = {
  criativos:   { id: '1GLgNjLzCqNdRyhB5V8lCh5LDT2VSiVnyXUJZQ0zpUss', gid: 1011478516, colunas: [1, 6, 7, 9, 20, 21, 22] },
  // Brasil: aba "Requisição BR" e a cópia com os pedidos de setembro (mesmo layout)
  criativosBR: { id: '1GLgNjLzCqNdRyhB5V8lCh5LDT2VSiVnyXUJZQ0zpUss', abas: ['Requisição BR', 'Cópia de Requisição BR 4'], colunas: [1, 2, 6, 7, 9, 10, 20, 22] },
  lancamentos: { id: '1hGdtF1oBKs-O0emjFX6YFtfZ9mPiDU100O9ZhXZ--Vg', aba: 'LANÇAMENTOS', colunas: [0, 2, 3, 4, 5, 7, 8] },
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

function enviar() {
  const body = {};
  for (const k in FONTES) body[k] = FONTES[k].abas ? lerAbas(FONTES[k]) : lerAba(FONTES[k]);
  const r = UrlFetchApp.fetch(SITE, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  console.log(r.getResponseCode() + ' ' + r.getContentText());
}

function instalar() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enviar').timeBased().everyMinutes(10).create();
  enviar();
}
