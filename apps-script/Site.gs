// Website → hub (menu Website). O relatório de hora em hora do Claude grava os números da Shopify
// na planilha "Hub – Relatório do site (não editar)" (células A1 e A2). Este script manda essas células
// para o site a cada 10 minutos. Só lê a planilha, nada é alterado.
// Para ligar: rode instalarSite() uma vez (Executar ▶).
const SITE_ID = '1golSE4Thy6O_hE2SF7GMTXEz1JhQF-QXrjtdZLKunVk';
const SITE_URL = 'https://hub-contentlarroude.vercel.app/api/ingest';

function enviarSite() {
  const vals = Sheets.Spreadsheets.Values.get(SITE_ID, 'A1:A2').values || [];
  if (!vals.length) return console.log('site: planilha vazia');
  const r = UrlFetchApp.fetch(SITE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    payload: JSON.stringify({ site: vals.map(v => [String(v[0] || '')]) }),
    muteHttpExceptions: true,
  });
  console.log('site: ' + r.getResponseCode() + ' ' + r.getContentText());
}

function instalarSite() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'enviarSite').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enviarSite').timeBased().everyMinutes(10).create();
  enviarSite();
}
