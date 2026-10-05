/**
 * Larroudé Content Hub — envia as planilhas para o site a cada 10 minutos.
 * Roda com a conta da Jess (só leitura nas planilhas). Nada é alterado nelas.
 *
 * Para começar: rode a função "instalar" uma vez (menu ▶ Executar) e autorize.
 */
const SITE = 'https://hub-contentlarroude.vercel.app/api/ingest';

const FONTES = {
  criativos:   { id: '1GLgNjLzCqNdRyhB5V8lCh5LDT2VSiVnyXUJZQ0zpUss', gid: 1011478516, colunas: [1, 6, 7, 9, 20, 21, 22] },
  lancamentos: { id: '1hGdtF1oBKs-O0emjFX6YFtfZ9mPiDU100O9ZhXZ--Vg', aba: 'LANÇAMENTOS', colunas: [0, 2, 3, 4, 5, 7, 8] },
};

function lerAba(f) {
  const ss = SpreadsheetApp.openById(f.id);
  const sh = f.aba ? ss.getSheetByName(f.aba) : ss.getSheets().find(s => s.getSheetId() === f.gid);
  const max = Math.max.apply(null, f.colunas) + 1;
  const vals = sh.getRange(1, 1, sh.getLastRow(), Math.min(max, sh.getLastColumn())).getDisplayValues();
  // mantém a posição das colunas, mas só envia as que o site usa
  return vals.map(r => r.map((v, i) => (f.colunas.indexOf(i) >= 0 ? v : '')));
}

function enviar() {
  const body = {};
  for (const k in FONTES) body[k] = lerAba(FONTES[k]);
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
