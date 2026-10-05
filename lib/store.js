// Armazenamento (Upstash Redis via Vercel Marketplace). Usa as variáveis que o Vercel cria sozinho.
const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function cmd(args) {
  if (!URL_()) throw new Error('banco de dados não conectado');
  const r = await fetch(URL_(), { method: 'POST', headers: { Authorization: 'Bearer ' + TOK(), 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
export async function put(key, value) { return cmd(['SET', key, JSON.stringify(value)]) }
export async function get(key) { const v = await cmd(['GET', key]); return v ? JSON.parse(v) : null }
