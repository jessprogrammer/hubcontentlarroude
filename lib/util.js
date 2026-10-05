// Utilidades compartilhadas
export function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else{if(c=='"')q=true;else if(c==','){row.push(f);f=''}else if(c=='\n'){row.push(f);rows.push(row);row=[];f=''}else if(c!='\r')f+=c}}row.push(f);rows.push(row);return rows}
export async function pool(items,n,fn){const out=new Array(items.length);let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k],k)}}));return out}
export async function getJSON(url,opt={},tries=4){for(let k=0;k<tries;k++){const r=await fetch(url,opt);if(r.ok)return r.json();if(r.status===429||r.status>=500){await new Promise(z=>setTimeout(z,800*(k+1)));continue}throw new Error(url+' -> '+r.status)}throw new Error(url+' -> retries')}
export async function getText(url,tries=4){for(let k=0;k<tries;k++){const r=await fetch(url);if(r.ok)return r.text();if(r.status===429||r.status>=500){await new Promise(z=>setTimeout(z,1000*(k+1)));continue}throw new Error('fetch '+r.status)}throw new Error('fetch retries')}
// cache em memória por instância (além do cache da CDN)
const mem=new Map();
export async function cached(key,ttlMs,fn){const e=mem.get(key);if(e&&Date.now()-e.t<ttlMs)return e.v;const v=await fn();mem.set(key,{t:Date.now(),v});return v}
export const WD=['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
export function iso(d){return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0')}
export function mondayOf(d){const x=new Date(d);x.setUTCDate(x.getUTCDate()-((x.getUTCDay()+6)%7));return x}
