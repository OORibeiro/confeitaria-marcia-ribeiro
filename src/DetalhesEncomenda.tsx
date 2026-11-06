import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

type Item = { item_id?: number; produto: string; variacao: string; quantidade: number; preco_unitario?: number; subtotal: number };
type Detalhes = {
  pedido_id: number; numero_pedido?: number | string; encontrado?: boolean;
  status_pedido?: string; status_pagamento?: string; forma_pagamento?: string;
  ambiente?: string; total?: number; frete?: number; itens?: Item[];
  codigo_rastreio?: string; prazo_producao_dias_uteis?: number;
  endereco?: Record<string, string | null> | null;
  datas?: Record<string, string | null>;
};
const moeda = (v: unknown) => v !== null && v !== undefined && Number.isFinite(Number(v))
  ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado';
const dataHora = (v?: string | null) => v && Number.isFinite(Date.parse(v))
  ? new Date(v).toLocaleString('pt-BR') : 'Não informada';
const status = (v?: string) => v ? v.replace(/_/g, ' ') : 'Não informado';

export default function DetalhesEncomenda({ pedidoId, usuarioId, administrador = false }: { pedidoId: number; usuarioId: string; administrador?: boolean }) {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [dados, setDados] = useState<Detalhes | null>(null);
  const [tentativa, setTentativa] = useState(0);
  const titulo = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const controller = new AbortController();
    let ativo = true;
    setCarregando(true); setErro(''); setDados(null);
    const timer = window.setTimeout(() => controller.abort(), 20000);
    async function carregar() {
      try {
        if (!supabase) throw new Error('A conexão com a loja está indisponível.');
        const { data, error } = await supabase.rpc(administrador ? 'mr_detalhes_pedido_admin' : 'consultar_checkout_cliente', { p_pedido_id: pedidoId })
          .abortSignal(controller.signal);
        if (error) throw new Error(error.code === '42501'
          ? 'Você não tem acesso a esse pedido. Confira sua sessão.'
          : 'Não foi possível consultar os detalhes. Tente novamente.');
        if (!data || data.encontrado === false || data.pedido_id !== pedidoId) {
          throw new Error('Não foi possível localizar os detalhes deste pedido.');
        }
        if (ativo) setDados(data);
      } catch (e) {
        if (ativo) setErro(e instanceof Error ? e.message : 'Falha ao consultar o pedido.');
      } finally {
        window.clearTimeout(timer);
        if (ativo) setCarregando(false);
      }
    }
    void carregar();
    titulo.current?.focus();
    return () => { ativo = false; controller.abort(); window.clearTimeout(timer); };
  }, [aberto, pedidoId, usuarioId, tentativa, administrador]);

  const datas = dados?.datas ?? {};
  const subtotal = dados?.itens?.length ? dados.itens.reduce((s, i) => s + Number(i.subtotal), 0) : undefined;
  return <div className="mt-3">
    <button type="button" aria-expanded={aberto} aria-controls={'detalhes-' + pedidoId}
      className="rounded-lg border border-amber-200 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-50"
      onClick={() => setAberto(a => !a)}>{aberto ? 'Fechar detalhes' : 'Ver detalhes'}</button>
    {aberto && <section id={'detalhes-' + pedidoId} aria-labelledby={'titulo-detalhes-' + pedidoId}
      className="mt-3 space-y-5 rounded-xl border border-stone-200 bg-stone-50 p-4 sm:p-5">
      <h4 id={'titulo-detalhes-' + pedidoId} ref={titulo} tabIndex={-1} className="font-serif text-lg font-bold">
        Detalhes da encomenda #{dados?.numero_pedido ?? pedidoId}
      </h4>
      {carregando && <p role="status" className="text-sm text-stone-600">Carregando detalhes…</p>}
      {erro && <div role="alert"><p className="text-sm text-red-700">{erro}</p>
        <button type="button" className="mt-2 text-sm font-semibold underline" onClick={() => setTentativa(n => n + 1)}>Tentar novamente</button></div>}
      {dados && <>
        {administrador && <div className="rounded-lg border border-amber-200 bg-white p-4">
          <h5 className="mb-2 font-semibold">Endereço de entrega deste pedido</h5>
          {dados.endereco ? <address className="not-italic text-sm space-y-1 break-words">
            <p>{dados.endereco.logradouro}, {dados.endereco.numero || 's/n'}</p>
            {dados.endereco.complemento && <p>{dados.endereco.complemento}</p>}
            <p>{dados.endereco.bairro}</p>
            <p>{dados.endereco.cidade} — {dados.endereco.estado}</p>
            <p className="font-semibold">CEP: {dados.endereco.cep?.replace(/^(\d{5})(\d{3})$/, '$1-$2') || 'Não informado'}</p>
          </address> : <p className="text-sm">Este pedido não possui endereço de entrega registrado.</p>}
        </div>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-stone-500">Situação do pedido</dt><dd className="font-semibold capitalize">{status(dados.status_pedido)}</dd></div>
          <div><dt className="text-stone-500">Pagamento</dt><dd className="font-semibold capitalize">{status(dados.status_pagamento)}</dd></div>
          <div><dt className="text-stone-500">Forma de pagamento</dt><dd className="font-semibold uppercase">{dados.forma_pagamento || 'Não informada'}</dd></div>
          <div><dt className="text-stone-500">Pedido realizado em</dt><dd>{dataHora(datas.pedido_criado_em)}</dd></div>
        </dl>
        {dados.ambiente === 'teste' && <p className="text-xs font-semibold text-amber-800">Pedido em ambiente de teste.</p>}
        <div>
          <h5 className="mb-2 font-semibold">Itens do pedido</h5>
          {dados.itens?.length ? <ul className="divide-y divide-stone-200">{dados.itens.map((item, i) =>
            <li key={item.item_id ?? i} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
              <div className="min-w-0 break-words"><p className="font-semibold">{item.quantidade} × {item.produto}</p>
                <p className="text-stone-600">{item.variacao}</p>
                {item.preco_unitario != null && <p className="text-xs text-stone-500">Unidade: {moeda(item.preco_unitario)}</p>}
              </div><strong>{moeda(item.subtotal)}</strong>
            </li>)}</ul> : <p className="text-sm text-stone-500">Os itens não foram disponibilizados nesta consulta.</p>}
          <dl className="mt-3 space-y-2 border-t border-stone-200 pt-3 text-sm">
            <div className="flex justify-between gap-3"><dt>Subtotal dos itens</dt><dd>{moeda(subtotal)}</dd></div>
            <div className="flex justify-between gap-3"><dt>Frete</dt><dd>{moeda(dados.frete)}</dd></div>
            <div className="flex justify-between gap-3 text-base font-bold"><dt>Total</dt><dd>{moeda(dados.total)}</dd></div>
          </dl>
        </div>
        <div>
          <h5 className="mb-3 font-semibold">Datas e acompanhamento</h5>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-stone-500">Data do pagamento</dt><dd>{dataHora(datas.pagamento_aprovado_em)}</dd>
              {!datas.pagamento_aprovado_em && <p className="mt-1 text-xs text-stone-500">A data não está disponível no registro deste pagamento.</p>}
            </div>
            {([
              ['producao_iniciada_em', 'Produção iniciada'],
              ['producao_concluida_em', 'Produção concluída'],
              ['postado_em', 'Pedido postado'],
              ['entregue_em', 'Pedido entregue'],
            ] as const).map(([campo, rotulo]) => <div key={campo}><dt className="text-stone-500">{rotulo}</dt><dd>{dataHora(datas[campo])}</dd></div>)}
          </dl>
          {dados.prazo_producao_dias_uteis != null && <p className="mt-4 text-sm">Prazo de produção: {dados.prazo_producao_dias_uteis} dia(s) útil(eis).</p>}
          {dados.codigo_rastreio && <p className="mt-3 break-all text-sm"><strong>Código de rastreio:</strong> {dados.codigo_rastreio}</p>}
        </div>
        <button type="button" className="text-sm font-semibold text-amber-900 underline" onClick={() => setTentativa(n => n + 1)}>Atualizar detalhes</button>
      </>}
    </section>}
  </div>;
}
