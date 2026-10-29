// PACOTE 05. Substitua o código completo da função melhor-envio-cotacao.
// Mantém o ambiente sandbox. Nenhum token é devolvido ao navegador.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): unknown;
};

type Dependencies = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  log: (step: string, status?: number) => void;
};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
class Failure extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function normalizarServicos(data: unknown) {
  const lista = Array.isArray(data) ? data : data && typeof data === 'object' && 'id' in data ? [data] : [];
  const ids = new Set<number>();
  return lista.flatMap((item: any) => {
    if (!item || item.error) return [];
    const id = Number(item.id);
    const textoPreco = String(item.custom_price ?? item.price ?? '').trim();
    const prazoOriginal = item.custom_delivery_time ?? item.delivery_time;
    const prazo = Number(prazoOriginal);
    const nome = typeof item.name === 'string' ? item.name.trim() : '';
    const empresa = typeof item.company?.name === 'string' ? item.company.name.trim() : '';
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647 || ids.has(id)
      || !/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(textoPreco)
      || Number(textoPreco) <= 0 || Number(textoPreco) > 1000000
      || prazoOriginal === null || prazoOriginal === undefined || prazoOriginal === ''
      || !Number.isInteger(prazo) || prazo < 0 || prazo > 365
      || !nome || nome.length > 120 || !empresa || empresa.length > 120) return [];
    ids.add(id);
    return [{ id, name: nome, price: Number(textoPreco).toFixed(2), delivery_time: prazo,
      company: { name: empresa } }];
  });
}

export async function handleRequest(req: Request, dependencies?: Partial<Dependencies>): Promise<Response> {
  const deps: Dependencies = {
    env: name => Deno.env.get(name), fetch: globalThis.fetch,
    log: (step, status) => console.error('falha_cotacao_frete', { etapa: step, status }),
    ...dependencies,
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply({ error: 'Use o método POST.' }, 405);
  let etapa = 'configuracao';
  try {
    const url = deps.env('SUPABASE_URL');
    const publicKey = deps.env('SUPABASE_ANON_KEY');
    const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
    const origin = deps.env('MELHORENVIO_CEP_ORIGEM');
    const contact = deps.env('MELHORENVIO_CONTACT_EMAIL');
    if (!url || !publicKey || !serviceKey || !origin || !contact || !/^\d{8}$/.test(origin)) {
      throw new Failure(503, 'A cotação de frete está indisponível. Entre em contato com a loja.');
    }
    const authorization = req.headers.get('Authorization') ?? '';
    if (!/^Bearer \S+$/i.test(authorization)) throw new Failure(401, 'Entre na sua conta para calcular o frete.');
    const texto = await req.text();
    if (texto.length > 20000) throw new Failure(413, 'Carrinho fora do limite permitido.');
    let body: any;
    try { body = JSON.parse(texto); } catch { throw new Failure(400, 'Envie o carrinho em formato JSON.'); }
    if (!body || typeof body.cepDestino !== 'string' || !/^\d{8}$/.test(body.cepDestino)) {
      throw new Failure(400, 'Informe o CEP com 8 números.');
    }
    if (!Array.isArray(body.itens) || body.itens.length < 1 || body.itens.length > 10) {
      throw new Failure(400, 'Informe os itens do carrinho, com limite de 10 potes.');
    }
    // Preço, peso e quantidadePotes enviados separadamente não têm efeito.
    const signal = AbortSignal.timeout(55000);
    etapa = 'autenticacao';
    const authResponse = await deps.fetch(`${url}/auth/v1/user`, {
      headers: { apikey: publicKey, Authorization: authorization }, signal,
    });
    if (!authResponse.ok) throw new Failure(authResponse.status >= 500 ? 503 : 401,
      authResponse.status >= 500 ? 'Não foi possível validar sua sessão agora.' : 'Sua sessão expirou. Entre novamente.');
    const user = await authResponse.json();
    if (!user?.id || user.is_anonymous === true) throw new Failure(401, 'Use uma conta de cliente para calcular o frete.');

    async function rpc(name: string, args: unknown, admin = false) {
      const response = await deps.fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', signal,
        headers: { apikey: admin ? serviceKey! : publicKey!,
          Authorization: admin ? `Bearer ${serviceKey}` : authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (data?.code === '22023') throw new Failure(409, data.message || 'O carrinho mudou. Calcule novamente.');
        if (!admin && data?.code === '42501') throw new Failure(403, 'Entre na sua conta e conclua seu cadastro para calcular o frete.');
        throw new Failure(503, 'Não foi possível registrar a cotação. Tente novamente em instantes.');
      }
      return data;
    }
    etapa = 'preparar_volume';
    const contexto = await rpc('preparar_cotacao_frete_cliente', { p_itens: body.itens });
    if (!contexto?.volume || !Array.isArray(contexto.itens)) throw new Failure(503, 'Não foi possível preparar a embalagem.');

    etapa = 'credencial_melhor_envio';
    let accessToken = await meToken(deps);
    etapa = 'consultar_melhor_envio';
    const consultarProvedor = () => deps.fetch('https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
        'Content-Type': 'application/json', 'User-Agent': `Confeitaria Márcia Ribeiro (${contact})` },
      body: JSON.stringify({ from: { postal_code: origin }, to: { postal_code: body.cepDestino },
        volumes: [contexto.volume], options: { receipt: false, own_hand: false } }),
    });
    let quote = await consultarProvedor();
    if (quote.status === 401) {
      accessToken = await meToken(deps, accessToken);
      quote = await consultarProvedor();
    }
    if (!quote.ok) throw new Failure(502, 'O Melhor Envio não conseguiu calcular o frete. Tente novamente em instantes.');
    const servicos = normalizarServicos(await quote.json());
    if (!servicos.length) throw new Failure(422, 'Nenhuma transportadora disponível para este destino e embalagem.');
    etapa = 'registrar_cotacao';
    const result = await rpc('registrar_cotacao_frete_servidor', {
      p_usuario: user.id, p_contexto: contexto, p_cep_origem: origin,
      p_cep_destino: body.cepDestino, p_servicos: servicos,
    }, true);
    if (!result?.sucesso || !result.cotacao_id) throw new Failure(503, 'Não foi possível salvar a cotação.');
    return reply(result);
  } catch (error) {
    const status = error instanceof Failure ? error.status : 503;
    deps.log(etapa, status);
    return reply({ error: error instanceof Failure ? error.message : 'A cotação de frete está indisponível. Tente novamente em instantes.' }, status);
  }
}

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

if (typeof Deno !== 'undefined') Deno.serve(req => handleRequest(req));
