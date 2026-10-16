// Calendário de CRM → hub (menu Calendário › CRM e canais).
// Lê a planilha "2026 CRM/Email calendar" (abas "US - OUT", "BRA - OUT"...), só as colunas A–H,
// e manda para o site a cada 10 minutos. A planilha é só lida, nada é alterado nela.
// Para ligar: rode instalarCRM() uma vez (Executar ▶).
const CRM_ID = '1cYqXUrZNktKCQjlufedmAcaS92bGA6fgtM4kup_TLZQ';
const CRM_SITE = 'https://hub-contentlarroude.vercel.app/api/ingest';

function enviarCRM() {
  const nomes = Sheets.Spreadsheets.get(CRM_ID, { fields: 'sheets.properties(title)' }).sheets
    .map(s => s.properties.title).filter(t => /^(US|BRA?)\s*-\s*[A-Za-zÇç]{3}/i.test(t.trim()));
  const res = Sheets.Spreadsheets.Values.batchGet(CRM_ID, { ranges: nomes.map(n => "'" + n + "'!A1:H200") });
  const linhas = [];
  (res.valueRanges || []).forEach((vr, k) => {
    (vr.values || []).forEach(r => {
      if (!r.some(v => String(v).trim())) return;
      const linha = r.slice(0, 8);
      while (linha.length < 25) linha.push('');
      linha[25] = nomes[k]; // nome da aba (coluna Z)
      linhas.push(linha);
    });
  });
  const r = UrlFetchApp.fetch(CRM_SITE, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    payload: JSON.stringify({ crm: linhas }),
    muteHttpExceptions: true,
  });
  console.log('crm: ' + r.getResponseCode() + ' ' + r.getContentText());
}

function instalarCRM() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'enviarCRM').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enviarCRM').timeBased().everyMinutes(10).create();
  enviarCRM();
}
