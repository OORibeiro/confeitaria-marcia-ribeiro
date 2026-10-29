import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

export type EstadoCheckout = 'aguardando_pix' | 'pendente' | 'confirmando' | 'aprovado' | 'expirado' | 'em_analise';
export interface PedidoCheckout {
  encontrado: true; pedido_id: number; numero_pedido?: string; estado: EstadoCheckout;
  status_pedido: string; total: number; frete?: number; order_id?: string | null;
  pix_expira_em?: string | null; reserva_expira_em?: string | null;
  chave_solicitacao?: string | null; codigo_rastreio?: string | null;
  datas?: { pedido_criado_em?: string };
  itens?: Array<{ produto: string; variacao: string; quantidade: number; subtotal: number }>;
  data_servidor?: string;
}
interface Marcador { chave?: string; pedidoId?: number }
interface Pix { copia_e_cola: string | null; imagem_base64: string | null }
export interface InicioCheckout { p_chave_solicitacao?: string; p_endereco: Record<string, string | null>;
  p_itens: Array<{ produto_id: number; variacao_id: number; quantidade: number }>;
  p_cotacao_id: string; p_servico_id: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const estados: EstadoCheckout[] = ['aguardando_pix','pendente','confirmando','aprovado','expirado','em_analise'];

export function useCheckout(client: SupabaseClient | null, usuarioId: string | undefined,
  usuarioAtualRef: MutableRefObject<string | null>, visivel: boolean) {
  const [pedido, setPedido] = useState<PedidoCheckout | null>(null);
  const [pix, setPix] = useState<Pix | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [temTentativa, setTemTentativa] = useState(false);
  const marcador = useRef<Marcador | null>(null);
  const versao = useRef(0);
  const executando = useRef(false);
  const pedidoRef = useRef<PedidoCheckout | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const diferencaRelogio = useRef(0);
  const chaveStorage = (id: string) => `mr.checkout.v3.${id}`;
  const atual = (v: number, id: string) => v === versao.current && usuarioAtualRef.current === id;

  function salvar(id: string, valor: Marcador | null) {
    marcador.current = valor;
    setTemTentativa(Boolean(valor));
    try {
      if (valor) window.localStorage.setItem(chaveStorage(id), JSON.stringify(valor));
      else window.localStorage.removeItem(chaveStorage(id));
    } catch {
      setAviso('A recuperação não pôde ser salva neste navegador. Você ainda pode retomar pela sua conta.');
    }
  }
  function ler(id: string): Marcador | null {
    try {
      const valor = JSON.parse(window.localStorage.getItem(chaveStorage(id)) || 'null');
      if (!valor || typeof valor !== 'object') return null;
      const chave = typeof valor.chave === 'string' && uuid.test(valor.chave) ? valor.chave : undefined;
      const pedidoId = Number.isSafeInteger(valor.pedidoId) && valor.pedidoId > 0 ? valor.pedidoId : undefined;
      return chave || pedidoId ? { chave, pedidoId } : null;
    } catch { return null; }
  }
  async function limitar<T>(fn: (signal: AbortSignal) => PromiseLike<T>, tempo = 20000): Promise<T> {
    const controller = new AbortController(); controllers.current.add(controller);
    const timer = window.setTimeout(() => controller.abort(), tempo);
    try { return await fn(controller.signal); }
    finally { window.clearTimeout(timer); controllers.current.delete(controller); }
  }
  async function rpc(nome: string, args: Record<string, unknown>) {
    if (!client) throw new Error('O acesso à loja está indisponível.');
    const { data, error } = await limitar(signal => client.rpc(nome, args).abortSignal(signal));
    if (error) {
      if (['22023','P0001'].includes(error.code)) throw new Error(error.message);
      if (error.code === '42501') throw new Error('Pedido sem acesso. Confira sua sessão e entre novamente.');
      throw new Error('Não foi possível confirmar a operação. Retome a mesma tentativa.');
    }
    return data;
  }
  function aceitar(data: any, v: number, id: string, preservarConfirmacao = true): PedidoCheckout | null {
    if (!atual(v,id)) return null;
    if (!data?.encontrado) return null;
    if (!Number.isSafeInteger(data.pedido_id) || data.pedido_id <= 0 || !estados.includes(data.estado)) {
      throw new Error('A resposta do pedido está incompleta. Consulte novamente.');
    }
    const prox: PedidoCheckout = { ...data, total: Number(data.total) };
    if (data.data_servidor && Number.isFinite(Date.parse(data.data_servidor))) {
      diferencaRelogio.current = Date.parse(data.data_servidor) - Date.now();
    }
    const anterior = pedidoRef.current;
    if (preservarConfirmacao && anterior?.pedido_id === prox.pedido_id && anterior.estado === 'confirmando'
      && ['pendente','expirado'].includes(prox.estado)) prox.estado = 'confirmando';
    if (anterior?.pedido_id !== prox.pedido_id || !['pendente'].includes(prox.estado)) setPix(null);
    pedidoRef.current = prox; setPedido(prox);
    if (prox.estado === 'aprovado') salvar(id,null);
    return prox;
  }
  async function consultar(m: Marcador, v: number, id: string) {
    const args = m.pedidoId ? { p_pedido_id: m.pedidoId } : { p_chave_solicitacao: m.chave };
    const data = await rpc('consultar_checkout_cliente', args);
    return aceitar(data,v,id);
  }
  async function consultarPix(p: PedidoCheckout, somenteConsulta: boolean, v: number, id: string) {
    if (!client || !atual(v,id) || p.estado === 'aprovado') return;
    const { data, error } = await client.auth.getSession();
    if (!atual(v,id)) return;
    if (error || !data.session || data.session.user.id !== id) throw new Error('Sua sessão expirou. Entre novamente.');
    const response = await limitar(signal => fetch(`${SUPABASE_URL}/functions/v1/checkout-pix-cliente-teste`, {
      method: 'POST', signal, headers: { 'Content-Type':'application/json', apikey:SUPABASE_ANON_KEY,
        Authorization:`Bearer ${data.session!.access_token}` },
      body:JSON.stringify({ pedido_id:p.pedido_id, somente_consulta:somenteConsulta }),
    }),65000);
    const json = await response.json().catch(() => null);
    if (!atual(v,id)) return;
    if (!response.ok || !json?.sucesso) throw new Error(json?.mensagem || 'Não foi possível consultar o PIX. Retome este mesmo pedido.');
    if (json.pedido_id !== p.pedido_id || !estados.includes(json.estado)) throw new Error('O PIX retornado não corresponde ao pedido.');
    let estado = json.estado as EstadoCheckout;
    // Só o banco confirma aprovação; uma resposta divergente é reconciliada por nova consulta.
    if (estado === 'aprovado') {
      const confirmado = await consultar({ pedidoId:p.pedido_id },v,id);
      if (confirmado?.estado !== 'aprovado' && atual(v,id)) estado = confirmado?.estado === 'em_analise' ? 'em_analise' : 'confirmando';
      else return;
    }
    if (!atual(v,id)) return;
    const prox = { ...(pedidoRef.current ?? p), estado, order_id:json.order_id ?? p.order_id,
      pix_expira_em:json.expira_em ?? p.pix_expira_em };
    pedidoRef.current = prox; setPedido(prox);
    const valida = estado === 'pendente' && Number.isFinite(Date.parse(prox.pix_expira_em ?? ''))
      && Date.parse(prox.pix_expira_em!) > Date.now()+diferencaRelogio.current;
    setPix(valida && json.pix ? {
      copia_e_cola:typeof json.pix.copia_e_cola === 'string' ? json.pix.copia_e_cola : null,
      imagem_base64:typeof json.pix.imagem_base64 === 'string' ? json.pix.imagem_base64 : null,
    } : null);
  }
  async function operacao(fn: (v: number,id: string) => Promise<unknown>, silenciosa = false) {
    if (!usuarioId || !client || executando.current) return;
    const id = usuarioId; const v = versao.current;
    if (!atual(v,id)) return;
    executando.current = true; setOcupado(true); if (!silenciosa) setErro(null);
    try { return await fn(v,id); }
    catch (error: any) {
      if (atual(v,id)) setErro(error?.name === 'AbortError'
        ? 'A resposta demorou. Consulte novamente o mesmo pedido antes de fazer outra compra.'
        : error.message || 'Não foi possível consultar. Tente novamente com o mesmo pedido.');
      return null;
    } finally {
      if (atual(v,id)) { executando.current = false; setOcupado(false); }
    }
  }
  async function abrirInterno(m: Marcador,v: number,id: string,restaurarPix = true) {
    const p = await consultar(m,v,id);
    if (!atual(v,id)) return null;
    if (!p) {
      setAviso('Nenhum pedido foi encontrado para essa tentativa. Você pode refazer o carrinho usando a mesma tentativa.');
      return null;
    }
    if (p.estado !== 'aprovado') salvar(id,{ ...m,pedidoId:p.pedido_id });
    if (restaurarPix && p.order_id && !['aprovado','em_analise'].includes(p.estado)) await consultarPix(p,true,v,id);
    return p;
  }
  const recuperar = () => operacao((v,id) => marcador.current ? abrirInterno(marcador.current,v,id) : Promise.resolve(null));
  const abrir = (pedidoId: number) => operacao((v,id) => abrirInterno({ pedidoId },v,id));
  const atualizar = () => operacao(async(v,id) => {
    const p = pedidoRef.current;
    if (p) await abrirInterno({ pedidoId:p.pedido_id },v,id);
    else if (marcador.current) await abrirInterno(marcador.current,v,id);
  });
  const gerarOuRetomarPix = () => operacao(async(v,id) => {
    const antigo = pedidoRef.current; if (!antigo) return;
    const p = await consultar({ pedidoId:antigo.pedido_id },v,id);
    if (!p || !atual(v,id) || ['aprovado','em_analise'].includes(p.estado)) return;
    await consultarPix(p,Boolean(p.order_id) || p.estado === 'expirado',v,id);
  });
  const iniciar = (entrada: InicioCheckout) => operacao(async(v,id) => {
    const existente = marcador.current;
    if (existente) {
      const p = await abrirInterno(existente,v,id,false);
      if (!atual(v,id)) return;
      if (p) return p;
    }
    const chave = existente?.chave ?? crypto.randomUUID();
    pedidoRef.current=null;setPedido(null);setPix(null);
    salvar(id,{ chave }); setAviso(null);
    const data = await rpc('iniciar_checkout_cliente',{ ...entrada,p_chave_solicitacao:chave });
    const p = aceitar(data,v,id,false);
    if (!p || !atual(v,id)) return null;
    salvar(id,{ chave,pedidoId:p.pedido_id });
    // O pedido já está seguro no banco. A tela apresenta a ação de gerar/retomar PIX.
    return p;
  });
  function novaCompra() {
    if (executando.current || !usuarioId) return;
    versao.current += 1;
    for (const c of controllers.current) c.abort(); controllers.current.clear();
    salvar(usuarioId,null); pedidoRef.current=null;setPedido(null);setPix(null);setErro(null);setAviso(null);
  }

  useEffect(() => {
    versao.current += 1; const v=versao.current;
    for (const c of controllers.current) c.abort(); controllers.current.clear();
    executando.current=false;setOcupado(false);pedidoRef.current=null;setPedido(null);setPix(null);setErro(null);setAviso(null);
    diferencaRelogio.current=0;marcador.current=null;setTemTentativa(false);
    if (!usuarioId || !client || usuarioAtualRef.current!==usuarioId) return;
    const id=usuarioId;const m=ler(id);marcador.current=m;setTemTentativa(Boolean(m));
    let cancelado=false;
    // Deixa o efeito de autenticação terminar antes de consultar a sessão.
    const timer=window.setTimeout(() => { if (!cancelado && m && atual(v,id)) void recuperar(); },0);
    return () => {
      cancelado=true;window.clearTimeout(timer);versao.current+=1;
      for (const c of controllers.current)c.abort();controllers.current.clear();
    };
  },[usuarioId,client]);

  useEffect(() => {
    if (!visivel || !pedido?.pedido_id || pedido.estado==='aprovado') return;
    const timer=window.setInterval(() => {
      if (document.visibilityState!=='visible') return;
      void operacao(async(v,id) => { await consultar({ pedidoId:pedido.pedido_id },v,id); },true);
    },15000);
    return () => window.clearInterval(timer);
  },[visivel,pedido?.pedido_id,pedido?.estado]);

  useEffect(() => {
    if (!pedido?.pix_expira_em || pedido.estado!=='pendente') return;
    const p=pedido;const v=versao.current;const id=usuarioId;
    const timer=window.setTimeout(() => {
      if (!id || !atual(v,id) || pedidoRef.current?.estado!=='pendente') return;
      const prox={ ...pedidoRef.current,estado:'expirado' as EstadoCheckout };
      pedidoRef.current=prox;setPedido(prox);setPix(null);
    },Math.max(0,Date.parse(p.pix_expira_em!)-Date.now()-diferencaRelogio.current));
    return () => window.clearTimeout(timer);
  },[pedido?.pedido_id,pedido?.estado,pedido?.pix_expira_em,usuarioId]);

  return { pedido,pix,erro,aviso,ocupado,temTentativa,iniciar,abrir,recuperar,atualizar,gerarOuRetomarPix,novaCompra };
}
