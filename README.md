# Larroudé Content Hub

Site com três painéis, lidos ao vivo a cada visita (com cache curto):

| Painel | Fonte | Atualiza |
|---|---|---|
| Entregas Meta US | Pastas mensais do Air + planilha US Request – Meta | a cada ~10 min |
| Daily tasks (senha) | Planilha Controle de Entregas, aba LANÇAMENTOS | a cada ~5 min |
| Social | Instagram @larroude via API do Supermetrics | a cada ~1 h |

## Como os dados chegam

- **Air**: o site lê as pastas públicas direto, a cada visita.
- **Planilhas**: o Apps Script em `apps-script/` (guardado no Drive da Jess) lê as duas planilhas a cada 10 min e envia para `/api/ingest`. Só e-mails listados em `config.js → ingestEmails` são aceitos.
- **Instagram**: API do Supermetrics.

## Variáveis no Vercel (Settings → Environment Variables)

| Nome | O que colocar |
|---|---|
| `TEAM_PASSWORD` | Senha do Daily tasks |
| `SUPERMETRICS_API_KEY` | Chave de API do Supermetrics Hub |
| `IG_DS_USER` | (opcional) usuário da conexão do Instagram no Supermetrics |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Criadas sozinhas ao conectar o banco Upstash (Storage) |

## Mês novo no Air

Abra `config.js` e adicione uma linha em `airFolders` com o nome, o shortcode do link público
(`app.air.inc/a/<shortcode>`) e o id do board raiz. Salve, faça commit e push: o Vercel publica sozinho.

## Criativo sem tipo

Se um criativo não tem Branding/Conversion na planilha, ele aparece como "Sem tipo".
Defina o tipo em `overrides.js` (chave = 8 primeiros caracteres do board do Air).
