import React, { useState, useEffect, useRef } from 'react';
import IntegracaoMelhorEnvio from './IntegracaoMelhorEnvio';
import { supabase } from './supabase';
import { 
  ClipboardList, 
  Plus, 
  Loader2, 
  Package, 
  Truck, 
  CheckCircle,
  RefreshCw
} from 'lucide-react';

const etapas: Record<string, { texto: string; proxima?: string; acao?: string }> = {
  pendente: { texto: 'Aguardando pagamento' },
  pago: { texto: 'Pago', proxima: 'em_producao', acao: 'Iniciar produção' },
  em_producao: { texto: 'Em produção', proxima: 'pronto', acao: 'Marcar como pronto' },
  pronto: { texto: 'Pronto', proxima: 'enviado', acao: 'Registrar envio' },
  enviado: { texto: 'Enviado', proxima: 'entregue', acao: 'Marcar como entregue' },
  entregue: { texto: 'Entregue' },
  cancelado: { texto: 'Cancelado' },
  expirado: { texto: 'Expirado' },
};
const datasEtapas = [
  ['producao_iniciada_em', 'Produção iniciada'],
  ['producao_concluida_em', 'Produção concluída'],
  ['postado_em', 'Enviado'], ['entregue_em', 'Entregue'],
] as const;

export default function AdminPanel() {
  const [abaAtiva, setAbaAtiva] = useState<'pedidos' | 'produtos' | 'integracao'>(() => /^#me_(state|code|erro)=/.test(window.location.hash) ? 'integracao' : 'pedidos');
  
  // Estados de Pedidos
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [carregandoPedidos, setCarregandoPedidos] = useState(false);

  const [msgPedido, setMsgPedido] = useState<{ texto: string; tipo: 'sucesso' | 'erro' } | null>(null);
  const [atualizando, setAtualizando] = useState<number | null>(null);
  const [envioPedido, setEnvioPedido] = useState<number | null>(null);
  const [codigoRastreio, setCodigoRastreio] = useState('');
  const operacao = useRef(false);

  // Estados do Formulário de Produto
  const [formProduto, setFormProduto] = useState({
    nome_produto: '',
    nome_variacao: 'Pote 200g',
    preco: '18.90',
    peso_kg: '0.200',
    validade_dias: '7',
    prazo_dias_uteis: '2',
    tem_lactose: true,
    tem_gluten: true,
    estoque_inicial: '20',
    descricao_produto: ''
  });
  const [msgProduto, setMsgProduto] = useState<{ texto: string; tipo: 'sucesso' | 'erro' } | null>(null);
  const [salvandoProduto, setSalvandoProduto] = useState(false);

  useEffect(() => {
    if (abaAtiva === 'pedidos') {
      carregarPedidos();
    }
  }, [abaAtiva]);

  async function carregarPedidos() {
    if (!supabase || operacao.current) return;
    operacao.current = true;
    setCarregandoPedidos(true);
    try {
      const { data, error } = await supabase
        .from('Pedido')
        .select('*, Cliente(nome_clt, email_clt, telefone_clt), Pedido_Entrega(*)')
        .order('data_pdd', { ascending: false });

      if (error) throw error;
      setPedidos(data || []);
    } catch (err: any) {
      setMsgPedido({ texto: 'Erro ao carregar pedidos: ' + err.message, tipo: 'erro' });
    } finally {
      operacao.current = false;
      setCarregandoPedidos(false);
    }
  }

  async function atualizarStatus(pedido: any, novoStatus: string) {
    if (!supabase || operacao.current || etapas[pedido.status_pdd]?.proxima !== novoStatus) return;
    const rastreio = novoStatus === 'enviado' ? codigoRastreio.replace(/\s/g, '').toUpperCase() : null;
    if (rastreio !== null && !/^[A-Z]{2}[0-9]{9}[A-Z]{2}$/.test(rastreio)) {
      setMsgPedido({ texto: 'Rastreio inválido: use duas letras, nove números e duas letras. Exemplo: BR123456789BR.', tipo: 'erro' });
      return;
    }
    operacao.current = true;
    setAtualizando(pedido.id_pdd);
    setMsgPedido(null);
    try {
      const { data, error } = await supabase.rpc('atualizar_etapa_pedido_admin', {
        p_pedido_id: pedido.id_pdd,
        p_novo_status: novoStatus,
        p_codigo_rastreio: rastreio,
      });
      if (error) throw error;
      if (!data || data.pedido_id !== pedido.id_pdd || data.status_pedido !== novoStatus) {
        throw new Error('Resposta inesperada. Atualize a lista para conferir a etapa antes de tentar novamente.');
      }
      // Usa a etapa e as datas confirmadas pelo banco, sem antecipar a mudança na tela.
      setPedidos(atuais => atuais.map(p => p.id_pdd !== pedido.id_pdd ? p : {
        ...p, status_pdd: data.status_pedido, rastreio_pdd: data.codigo_rastreio,
        Pedido_Entrega: [{ ...(Array.isArray(p.Pedido_Entrega) ? p.Pedido_Entrega[0] : p.Pedido_Entrega), ...data.datas }],
      }));
      setEnvioPedido(null);
      setCodigoRastreio('');
      setMsgPedido({ texto: `Pedido #${pedido.numero_pdd || pedido.id_pdd}: ${etapas[novoStatus].texto}.`, tipo: 'sucesso' });
    } catch (err: any) {
      setMsgPedido({ texto: 'Não foi possível confirmar a atualização: ' + err.message + ' Atualize a lista antes de repetir a operação.', tipo: 'erro' });
    } finally {
      operacao.current = false;
      setAtualizando(null);
    }
  }

  async function cadastrarProduto(e: React.FormEvent) {
    e.preventDefault();
    setMsgProduto(null);
    if (!supabase) return;

    setSalvandoProduto(true);
    try {
      const { error } = await supabase.rpc('cadastrar_produto_com_variacao', {
        p_nome_produto: formProduto.nome_produto,
        p_nome_variacao: formProduto.nome_variacao,
        p_preco: Number(formProduto.preco),
        p_peso_kg: Number(formProduto.peso_kg),
        p_validade_dias: Number(formProduto.validade_dias),
        p_prazo_dias_uteis: Number(formProduto.prazo_dias_uteis),
        p_tem_lactose: formProduto.tem_lactose,
        p_tem_gluten: formProduto.tem_gluten,
        p_estoque_inicial: Number(formProduto.estoque_inicial),
        p_descricao_produto: formProduto.descricao_produto || null
      });

      if (error) throw error;
      
      setMsgProduto({ texto: 'Produto cadastrado com sucesso no Supabase!', tipo: 'sucesso' });
      // Limpa o formulário
      setFormProduto({ ...formProduto, nome_produto: '', descricao_produto: '' });
    } catch (err: any) {
      setMsgProduto({ texto: err.message, tipo: 'erro' });
    } finally {
      setSalvandoProduto(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden animate-in fade-in duration-300">
      {/* Menu Superior do Admin */}
      <div className="bg-stone-900 px-4 sm:px-6 py-4 flex flex-wrap gap-2 sm:gap-4">
        <button
          onClick={() => setAbaAtiva('pedidos')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            abaAtiva === 'pedidos' ? 'bg-amber-500 text-stone-900' : 'text-stone-300 hover:bg-stone-800'
          }`}
        >
          <ClipboardList className="w-4 h-4" /> Gestão de Pedidos
        </button>
        <button
          onClick={() => setAbaAtiva('produtos')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            abaAtiva === 'produtos' ? 'bg-amber-500 text-stone-900' : 'text-stone-300 hover:bg-stone-800'
          }`}
        >
          <Plus className="w-4 h-4" /> Cadastrar Produtos
        </button>
        <button onClick={() => setAbaAtiva('integracao')} className={`px-4 py-2 rounded-xl text-sm font-semibold ${abaAtiva === 'integracao' ? 'bg-amber-500 text-stone-900' : 'text-stone-300 hover:bg-stone-800'}`}>Melhor Envio</button>
      </div>

      <div className="p-6">
        {abaAtiva === 'integracao' && <IntegracaoMelhorEnvio />}
        {/* ABA: PEDIDOS */}
        {abaAtiva === 'pedidos' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-serif font-bold text-stone-900">Todos os Pedidos</h2>
              <button 
                onClick={() => { setMsgPedido(null); void carregarPedidos(); }}
                disabled={carregandoPedidos || atualizando !== null}
                className="flex items-center gap-2 text-sm text-stone-600 hover:text-stone-900 bg-stone-100 px-3 py-1.5 rounded-lg"
              >
                <RefreshCw className={`w-4 h-4 ${carregandoPedidos ? 'animate-spin' : ''}`} /> Atualizar
              </button>
            </div>

            {msgPedido && <div role={msgPedido.tipo === 'erro' ? 'alert' : 'status'} className={`mb-4 p-4 rounded-xl text-sm border ${msgPedido.tipo === 'erro' ? 'bg-red-50 text-red-800 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>{msgPedido.texto}</div>}

            {carregandoPedidos ? (
              <div className="flex justify-center py-10"><Loader2 className="w-8 h-8 animate-spin text-amber-800" /></div>
            ) : pedidos.length === 0 ? (
              <p className="text-center text-stone-500 py-10">Nenhum pedido encontrado.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b-2 border-stone-100 text-stone-500 text-sm">
                      <th className="pb-3 px-2 font-medium">Pedido</th>
                      <th className="pb-3 px-2 font-medium">Cliente</th>
                      <th className="pb-3 px-2 font-medium">Total</th>
                      <th className="pb-3 px-2 font-medium">Status Atual</th>
                      <th className="pb-3 px-2 font-medium text-right">Mudar Status para:</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {pedidos.map(ped => (
                      <tr key={ped.id_pdd} className="hover:bg-stone-50 transition-colors">
                        <td className="py-4 px-2">
                          <span className="font-bold text-stone-900">#{ped.numero_pdd || ped.id_pdd}</span>
                          <span className="block text-xs text-stone-500">{new Date(ped.data_pdd).toLocaleDateString('pt-BR')}</span>
                        </td>
                        <td className="py-4 px-2">
                          <span className="font-semibold text-stone-900 block">{ped.Cliente?.nome_clt}</span>
                          <span className="text-xs text-stone-500">{ped.Cliente?.email_clt}</span>
                        </td>
                        <td className="py-4 px-2 font-bold text-amber-900">
                          R$ {Number(ped.valor_pdd || 0).toFixed(2).replace('.', ',')}
                        </td>
                        <td className="py-4 px-2">
                          <span className={`text-xs font-bold px-2.5 py-1 rounded-full uppercase ${
                            ped.status_pdd === 'pendente' ? 'bg-stone-200 text-stone-700' :
                            ped.status_pdd === 'em_producao' ? 'bg-blue-100 text-blue-800' :
                            ped.status_pdd === 'pronto' || ped.status_pdd === 'enviado' ? 'bg-amber-100 text-amber-800' :
                            ped.status_pdd === 'pago' || ped.status_pdd === 'entregue' ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-700'
                          }`}>
                            {etapas[ped.status_pdd]?.texto || ped.status_pdd}
                          </span>
                          {ped.rastreio_pdd && <p className="text-xs text-stone-600 mt-2">Rastreio: <span className="font-mono">{ped.rastreio_pdd}</span></p>}
                          {datasEtapas.map(([chave, rotulo]) => {
                            const entrega = Array.isArray(ped.Pedido_Entrega) ? ped.Pedido_Entrega[0] : ped.Pedido_Entrega;
                            return entrega?.[chave] ? <p key={chave} className="text-xs text-stone-500 mt-1">{rotulo}: {new Date(entrega[chave]).toLocaleString('pt-BR')}</p> : null;
                          })}
                        </td>
                        <td className="py-4 px-2 text-right">
                          <div className="flex flex-col items-end gap-2 min-w-[210px]">
                            {etapas[ped.status_pdd]?.proxima ? (
                              envioPedido === ped.id_pdd && ped.status_pdd === 'pronto' ? (
                                <form className="w-full space-y-2" onSubmit={e => { e.preventDefault(); void atualizarStatus(ped, 'enviado'); }}>
                                  <label className="block text-left text-xs font-semibold" htmlFor={`rastreio-${ped.id_pdd}`}>Código de rastreio</label>
                                  <input id={`rastreio-${ped.id_pdd}`} value={codigoRastreio} onChange={e => setCodigoRastreio(e.target.value)}
                                    disabled={atualizando !== null} required maxLength={100} placeholder="BR123456789BR"
                                    className="w-full border rounded-lg px-3 py-2 text-sm uppercase" />
                                  <p className="text-xs text-stone-500 text-left">Duas letras, nove números e duas letras.</p>
                                  <div className="flex justify-end gap-2">
                                    <button type="button" disabled={atualizando !== null} onClick={() => { setEnvioPedido(null); setCodigoRastreio(''); }} className="text-sm px-2 py-2">Cancelar</button>
                                    <button type="submit" disabled={atualizando !== null} className="text-sm px-3 py-2 rounded-lg bg-amber-100 text-amber-900 disabled:opacity-40">Confirmar envio</button>
                                  </div>
                                </form>
                              ) : (
                                <button disabled={atualizando !== null || carregandoPedidos} onClick={() => {
                                  if (ped.status_pdd === 'pronto') { setEnvioPedido(ped.id_pdd); setCodigoRastreio(''); setMsgPedido(null); }
                                  else void atualizarStatus(ped, etapas[ped.status_pdd].proxima!);
                                }} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-amber-100 text-amber-900 hover:bg-amber-200 disabled:opacity-40">
                                  {atualizando === ped.id_pdd ? <Loader2 className="w-4 h-4 animate-spin" /> : ped.status_pdd === 'pronto' ? <Truck className="w-4 h-4" /> : ped.status_pdd === 'enviado' ? <CheckCircle className="w-4 h-4" /> : <Package className="w-4 h-4" />}
                                  {etapas[ped.status_pdd].acao}
                                </button>
                              )
                            ) : <span className="text-xs text-stone-500">{ped.status_pdd === 'pendente' ? 'Aguardando confirmação do pagamento' : ped.status_pdd === 'entregue' ? 'Pedido concluído' : 'Sem alteração disponível'}</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ABA: CADASTRAR PRODUTOS */}
        {abaAtiva === 'produtos' && (
          <div className="max-w-2xl mx-auto">
            <h2 className="text-xl font-serif font-bold text-stone-900 mb-6">Cadastrar Novo Doce</h2>
            
            <form onSubmit={cadastrarProduto} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Nome do Produto *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Bolo de Pote Prestígio"
                    value={formProduto.nome_produto}
                    onChange={e => setFormProduto({ ...formProduto, nome_produto: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Nome da Variação *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Pote 200g"
                    value={formProduto.nome_variacao}
                    onChange={e => setFormProduto({ ...formProduto, nome_variacao: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Preço (R$) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={formProduto.preco}
                    onChange={e => setFormProduto({ ...formProduto, preco: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Peso (kg) *</label>
                  <input
                    type="number"
                    step="0.001"
                    required
                    value={formProduto.peso_kg}
                    onChange={e => setFormProduto({ ...formProduto, peso_kg: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Validade (dias) *</label>
                  <input
                    type="number"
                    required
                    value={formProduto.validade_dias}
                    onChange={e => setFormProduto({ ...formProduto, validade_dias: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1">Estoque Inicial *</label>
                  <input
                    type="number"
                    required
                    value={formProduto.estoque_inicial}
                    onChange={e => setFormProduto({ ...formProduto, estoque_inicial: e.target.value })}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1">Descrição do Produto</label>
                <textarea
                  rows={3}
                  placeholder="Descreva os ingredientes e detalhes para o cliente..."
                  value={formProduto.descricao_produto}
                  onChange={e => setFormProduto({ ...formProduto, descricao_produto: e.target.value })}
                  className="w-full border border-stone-300 rounded-xl px-3.5 py-2.5 text-sm"
                />
              </div>

              {msgProduto && (
                <div className={`p-4 rounded-xl text-sm font-medium ${msgProduto.tipo === 'sucesso' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
                  {msgProduto.texto}
                </div>
              )}

              <button 
                type="submit" 
                disabled={salvandoProduto}
                className="w-full bg-emerald-700 hover:bg-emerald-800 disabled:bg-stone-400 text-white px-6 py-3.5 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {salvandoProduto ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
                Salvar Produto
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
