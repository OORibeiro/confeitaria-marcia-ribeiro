// PACOTE 05 — SANDBOX
declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(req:Request)=>Promise<Response>):unknown};
class Failure extends Error {constructor(public status:number,message:string){super(message);}}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
// Helpers incluídos neste arquivo para permitir publicação pelo editor do Supabase.
type MEDeps = { env: (name:string)=>string|undefined; fetch: typeof fetch };
async function meRpc(d: MEDeps, name:string, body:unknown, authorization?:string) {
  const service = !authorization;
  const key=d.env(service?'SUPABASE_SERVICE_ROLE_KEY':'SUPABASE_ANON_KEY');
  const url=d.env('SUPABASE_URL');
  if(!key || !url) throw new Failure(503,'Configuração do servidor incompleta.');
  const r=await d.fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',
    headers:{apikey:key,Authorization:authorization ?? `Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const data=await r.json().catch(()=>null);
  if(!r.ok) throw new Failure(data?.code==='42501'?403:data?.code==='22023'?409:503,
    data?.code==='42501'?'Somente administrador ativo.':data?.code==='22023'?'Solicitação inválida, expirada ou já utilizada. Inicie novamente.':'Não foi possível concluir a operação no servidor.');
  return data;
}
async function meAdmin(req:Request,d:MEDeps) {
  const a=req.headers.get('Authorization')??'';
  if(!/^Bearer \S+$/i.test(a))throw new Failure(401,'Entre com sua conta administradora.');
  const key=d.env('SUPABASE_ANON_KEY'),url=d.env('SUPABASE_URL');
  if(!key||!url)throw new Failure(503,'Configuração do servidor incompleta.');
  const r=await d.fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:a},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Failure(r.status>=500?503:401,'Não foi possível validar a sessão.');
  const u=await r.json();if(!u?.id||u.is_anonymous)throw new Failure(401,'Entre com sua conta administradora.');
  const admin=await meRpc(d,'verificar_sou_admin',{},a);
  if(admin!==true)throw new Failure(403,'Somente administrador ativo.');
  return {authorization:a,userId:u.id as string};
}
async function meHash(value:string) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function meConfig(d:MEDeps) {
 const client=d.env('MELHORENVIO_CLIENT_ID'),secret=d.env('MELHORENVIO_CLIENT_SECRET'),contact=d.env('MELHORENVIO_CONTACT_EMAIL');
 if(!client||!secret||!contact)throw new Failure(503,'Configuração OAuth incompleta.');
 return {client,secret,contact};
}
function meSite(d:MEDeps) {
 const raw=d.env('MELHORENVIO_SITE_ORIGIN');
 if(!raw)throw new Failure(503,'Configure MELHORENVIO_SITE_ORIGIN.');
 const u=new URL(raw);
 if(u.origin!==raw || u.username || u.password || !(u.protocol==='https:' || u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname)))
  throw new Failure(503,'MELHORENVIO_SITE_ORIGIN deve ser uma origem HTTPS ou localhost, sem barra final.');
 return u.origin;
}
async function meTrocar(d:MEDeps,body:Record<string,unknown>) {
 const c=meConfig(d);
 const r=await d.fetch('https://sandbox.melhorenvio.com.br/oauth/token',{method:'POST',
 headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':`Confeitaria Márcia Ribeiro (${c.contact})`},
 body:JSON.stringify({client_id:c.client,client_secret:c.secret,...body}),signal:AbortSignal.timeout(10000)});
 const t=await r.json().catch(()=>null),seconds=Number(t?.expires_in);
 if(!r.ok)throw new Failure(r.status===400||r.status===401?409:503,
  r.status===400||r.status===401?'A autorização do Melhor Envio precisa ser refeita no painel administrativo.':'O Melhor Envio não conseguiu renovar a conexão agora.');
 if(typeof t?.access_token!=='string'||!t.access_token||t.access_token.length>20000||typeof t.refresh_token!=='string'||!t.refresh_token||t.refresh_token.length>20000
 ||!Number.isFinite(seconds)||seconds<120||seconds>366*86400 || t.token_type && String(t.token_type).toLowerCase()!=='bearer')throw new Failure(503,'Resposta de credenciais inválida.');
 return {access:t.access_token as string,refresh:t.refresh_token as string,expires:new Date(Date.now()+seconds*1000).toISOString()};
}
async function meSalvar(d:MEDeps,lock:string,t:{access:string;refresh:string;expires:string},admin:string|null=null){
 // A mesma resposta é reutilizada caso a gravação tenha falhado antes de chegar ao banco.
 // Nunca repete a troca do refresh token no provedor dentro desta tentativa.
 const args={p_trava:lock,p_access:t.access,p_refresh:t.refresh,p_expira:t.expires,p_admin:admin};
 try{await meRpc(d,'me_token_concluir',args);}catch(e){
  if(e instanceof Failure && e.status!==503)throw e;
  await meRpc(d,'me_token_concluir',args);
 }
}
async function meSoltar(d:MEDeps,lock:string){try{await meRpc(d,'me_token_liberar',{p_trava:lock});}catch{/* lease vence sozinho; sem credenciais em logs */}}
async function meToken(d:MEDeps,rejected:string|null=null):Promise<string>{
 for(let attempt=0;attempt<12;attempt++){
  const v=await meRpc(d,'me_token_reservar',{p_modo:'renovar',p_rejeitado:rejected});
  if(v?.estado==='pronto' && typeof v.access_token==='string')return v.access_token;
  if(v?.estado==='reconectar')throw new Failure(503,'A conexão do frete precisa ser refeita pela loja.');
  if(v?.estado==='aguarde'){await new Promise(r=>setTimeout(r,250));continue;}
  if(v?.estado!=='renovar'||!v.trava||!v.refresh_token)throw new Failure(503,'Conexão do frete indisponível.');
  try{
   const t=await meTrocar(d,{grant_type:'refresh_token',refresh_token:v.refresh_token});
   await meSalvar(d,v.trava,t);return t.access;
  }finally{await meSoltar(d,v.trava);}
 }
 throw new Failure(503,'A conexão do frete está sendo atualizada. Tente novamente em instantes.');
}
export async function handleRequest(req:Request,dependencies?:Partial<MEDeps>):Promise<Response>{
 const d:MEDeps={env:n=>Deno.env.get(n),fetch:globalThis.fetch,...dependencies};
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST')return reply({error:'Inicie a autorização pelo painel administrativo.'},405);
 try{
  const a=await meAdmin(req,d);meSite(d);const c=meConfig(d);
  const redirect=d.env('MELHORENVIO_REDIRECT_URI');
  if(!redirect||redirect!==`${d.env('SUPABASE_URL')}/functions/v1/melhor-envio-callback`)throw new Failure(503,'Confira MELHORENVIO_REDIRECT_URI.');
  const state=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  await meRpc(d,'me_oauth_iniciar',{p_hash:await meHash(state)},a.authorization);
  const u=new URL('https://sandbox.melhorenvio.com.br/oauth/authorize');
  u.search=new URLSearchParams({client_id:c.client,redirect_uri:redirect,response_type:'code',state,scope:'shipping-calculate'}).toString();
  return reply({sucesso:true,url:u.toString(),state});
 }catch(e){return reply({error:e instanceof Failure?e.message:'Não foi possível iniciar a autorização.'},e instanceof Failure?e.status:503);}
}

if(typeof Deno!=='undefined')Deno.serve(req=>handleRequest(req));
