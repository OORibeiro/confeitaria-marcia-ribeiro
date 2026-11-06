import React, { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, Loader2, X } from 'lucide-react';
import { supabase } from './supabase';
import FotoProduto from './FotoProduto';

type Variacao = {
  id_var?: number; nome_var: string; preco_var: string; peso_var: string;
  validade_dias_var: string; prazo_producao_dias_uteis_var: string;
  tem_lactose_var: boolean; tem_gluten_var: boolean; ativo_var: boolean;
  quantidade_est: string; reservada_est: number;
};
type Produto = {
  id_prd?: number; versao?: string; nome_prd: string; descricao_prd: string;
  imagem_prd: string; ativo_prd: boolean; variacoes: Variacao[];
};
const novaVariacao = (): Variacao => ({ nome_var: '', preco_var: '18.90', peso_var: '0.200',
  validade_dias_var: '7', prazo_producao_dias_uteis_var: '2', tem_lactose_var: true,
  tem_gluten_var: true, ativo_var: true, quantidade_est: '0', reservada_est: 0 });
const novoProduto = (): Produto => ({ nome_prd: '', descricao_prd: '', imagem_prd: '', ativo_prd: true,
  variacoes: [{ ...novaVariacao(), nome_var: 'Pote 200g' }] });
function normalizar(p: any): Produto {
  return { id_prd: p.id_prd, versao: p.versao, nome_prd: p.nome_prd,
    descricao_prd: p.descricao_prd || '', imagem_prd: p.imagem_prd || '', ativo_prd: p.ativo_prd === true,
    variacoes: p.variacoes.map((v: any) => ({ id_var: v.id_var, nome_var: v.nome_var,
      preco_var: String(v.preco_var), peso_var: String(v.peso_var ?? '0.200'),
      validade_dias_var: String(v.validade_dias_var ?? 7),
      prazo_producao_dias_uteis_var: String(v.prazo_producao_dias_uteis_var ?? 2),
      tem_lactose_var: v.tem_lactose_var === true, tem_gluten_var: v.tem_gluten_var === true,
      ativo_var: v.ativo_var === true, quantidade_est: String(v.quantidade_est ?? 0),
      reservada_est: Number(v.reservada_est ?? 0) })) };
}
const campo = 'w-full border border-stone-300 rounded-xl px-3 py-2 text-sm bg-white disabled:opacity-60';
const botao = 'px-3 py-2 rounded-xl text-sm font-semibold border border-stone-200 disabled:opacity-50 flex items-center justify-center gap-2';

export default function GestaoProdutos({ onAlterado }: { onAlterado: () => void }) {
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const [recortePendente, setRecortePendente] = useState(false);
  const [form, setForm] = useState<Produto | null>(null);
  const [excluir, setExcluir] = useState<Produto | null>(null);
  const [busca, setBusca] = useState('');
  const [mensagem, setMensagem] = useState<{ texto: string; erro?: boolean } | null>(null);
  const trava = useRef(false);
  const vivo = useRef(false);
  const geracao = useRef(0);
  const tentativa = useRef<{ corpo: string; chave: string } | null>(null);
  useEffect(() => {
    vivo.current = true;
    void carregar();
    return () => { vivo.current = false; geracao.current++; };
  }, []);

  async function carregar() {
    const id = ++geracao.current;
    setCarregando(true);
    try {
      if (!supabase) throw new Error('Conexão com a loja indisponível.');
      const { data, error } = await supabase.rpc('mr_listar_produtos_admin');
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Resposta inesperada ao carregar produtos.');
      if (vivo.current && id === geracao.current) setProdutos(data.map(normalizar));
      return true;
    } catch (err: any) {
      if (vivo.current && id === geracao.current) setMensagem({ erro: true,
        texto: 'Não foi possível atualizar a lista: ' + err.message });
      return false;
    } finally {
      if (vivo.current && id === geracao.current) setCarregando(false);
    }
  }
  function abrir(p: Produto) {
    setRecortePendente(false); setEnviandoFoto(false);
    setForm(JSON.parse(JSON.stringify(p)));
    setExcluir(null); setMensagem(null); tentativa.current = null;
  }
  function mudarVariacao(i: number, patch: Partial<Variacao>) {
    setForm(p => p && ({ ...p, variacoes: p.variacoes.map((v, j) => i === j ? { ...v, ...patch } : v) }));
  }
  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !supabase || trava.current || enviandoFoto || recortePendente) return;
    trava.current = true; setOcupado(true); setMensagem(null);
    try {
      const nomes = form.variacoes.map(v => v.nome_var.trim().toLocaleLowerCase('pt-BR'));
      if (new Set(nomes).size !== nomes.length) throw new Error('Use nomes diferentes para cada variação.');
      if (form.variacoes.some(v => Number(v.quantidade_est) < v.reservada_est)) {
        throw new Error('O estoque físico não pode ser menor que a quantidade reservada.');
      }
      const dados = { ...form, nome_prd: form.nome_prd.trim(), imagem_prd: form.imagem_prd.trim(),
        variacoes: form.variacoes.map(({ reservada_est, ...v }) => ({ ...v, nome_var: v.nome_var.trim(),
          preco_var: Number(v.preco_var), peso_var: Number(v.peso_var),
          validade_dias_var: Number(v.validade_dias_var),
          prazo_producao_dias_uteis_var: Number(v.prazo_producao_dias_uteis_var), quantidade_est: Number(v.quantidade_est) })) };
      const corpo = JSON.stringify(dados);
      if (tentativa.current?.corpo !== corpo) tentativa.current = { corpo, chave: crypto.randomUUID() };
      const { data, error } = await supabase.rpc('mr_salvar_produto_admin', { p_dados: dados, p_chave: tentativa.current.chave });
      if (error) throw error;
      if (!data?.sucesso || !data.produto_id) throw new Error('Resposta inesperada. Atualize a lista antes de repetir.');
      onAlterado();
      if (!vivo.current) return;
      setForm(null); tentativa.current = null;
      const atualizou = await carregar();
      if (vivo.current) setMensagem({ erro: !atualizou,
        texto: atualizou ? `Produto #${data.produto_id} salvo com sucesso.` :
          `Produto #${data.produto_id} salvo, mas a lista não carregou. Clique em Atualizar; não cadastre novamente.` });
    } catch (err: any) {
      if (vivo.current) setMensagem({ erro: true, texto: err.message || 'Não foi possível salvar. Tente novamente.' });
    } finally {
      trava.current = false;
      if (vivo.current) setOcupado(false);
    }
  }
  async function confirmarExclusao() {
    if (!excluir || !supabase || trava.current) return;
    trava.current = true; setOcupado(true); setMensagem(null);
    try {
      const { data, error } = await supabase.rpc('mr_excluir_produto_admin', { p_id: excluir.id_prd, p_versao: excluir.versao });
      if (error) throw error;
      if (!data?.sucesso) throw new Error('Não foi possível confirmar a exclusão. Atualize a lista.');
      onAlterado();
      if (!vivo.current) return;
      setExcluir(null);
      const atualizou = await carregar();
      if (vivo.current) setMensagem({ erro: !atualizou, texto: atualizou ? 'Produto excluído.' : 'Produto excluído. Clique em Atualizar para recarregar a lista.' });
    } catch (err: any) {
      if (vivo.current) setMensagem({ erro: true, texto: err.message });
    } finally {
      trava.current = false;
      if (vivo.current) setOcupado(false);
    }
  }
  const bloqueado = ocupado || carregando;
  const filtrados = produtos.filter(p => `${p.id_prd} ${p.nome_prd}`.toLocaleLowerCase('pt-BR').includes(busca.toLocaleLowerCase('pt-BR')));
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-serif font-bold">Gestão de Produtos</h2>
      <div className="flex gap-2">
        <button type="button" className={botao} disabled={bloqueado || !!form} onClick={() => { setMensagem(null); setExcluir(null); void carregar(); }}>
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
        <button type="button" className={botao + ' bg-emerald-700 text-white'} disabled={bloqueado || !!form} onClick={() => abrir(novoProduto())}>
          <Plus className="w-4 h-4" /> Novo produto
        </button>
      </div>
    </div>
    {mensagem && <div role={mensagem.erro ? 'alert' : 'status'} className={`rounded-xl p-4 text-sm border ${mensagem.erro ? 'bg-red-50 text-red-800 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>{mensagem.texto}</div>}
    {form ? <form onSubmit={salvar} className="space-y-5">
      <fieldset disabled={ocupado || enviandoFoto} className="space-y-5 disabled:opacity-70">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold">{form.id_prd ? `Editar produto #${form.id_prd}` : 'Cadastrar novo produto'}</h3>
          <button type="button" className={botao} onClick={() => { setForm(null); setMensagem(null); tentativa.current = null; }}><X className="w-4 h-4" /> Cancelar</button>
        </div>
        <label className="block text-sm font-semibold">Nome do produto
          <input className={campo + ' mt-1'} required maxLength={150} value={form.nome_prd} onChange={e => setForm({ ...form, nome_prd: e.target.value })} />
        </label>
        <label className="block text-sm font-semibold">Descrição
          <textarea className={campo + ' mt-1'} rows={3} maxLength={10000} value={form.descricao_prd} onChange={e => setForm({ ...form, descricao_prd: e.target.value })} />
        </label>
        <FotoProduto valor={form.imagem_prd} onOcupado={setEnviandoFoto} onPendente={setRecortePendente}
          onChange={url => setForm(p => p && ({ ...p, imagem_prd: url }))} />
        <label className="flex gap-2 items-center text-sm font-semibold">
          <input type="checkbox" checked={form.ativo_prd} onChange={e => setForm({ ...form, ativo_prd: e.target.checked })} /> Produto ativo na loja
        </label>
        <p className="text-sm text-stone-600">Desativar retira o produto da venda e preserva seus pedidos. Cada variação corresponde a um pote; as caixas continuam seguindo a regra de até 10 potes de 12 × 12 × 12 cm.</p>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold">Variações ({form.variacoes.length})</h3>
          <button type="button" className={botao} disabled={form.variacoes.length >= 50} onClick={() => setForm({ ...form, variacoes: [...form.variacoes, novaVariacao()] })}><Plus className="w-4 h-4" /> Adicionar variação</button>
        </div>
        {form.variacoes.map((v, i) => <div key={v.id_var ? `id-${v.id_var}` : `nova-${i}`} className="border border-stone-200 rounded-xl p-4 space-y-4 bg-stone-50">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold">Variação {i + 1}{v.id_var ? ` · #${v.id_var}` : ' · nova'}</h4>
            {!v.id_var && form.variacoes.length > 1 && <button type="button" className={botao} onClick={() => setForm({ ...form, variacoes: form.variacoes.filter((_, j) => j !== i) })}>Remover</button>}
          </div>
          <label className="block text-sm">Nome / sabor
            <input className={campo + ' mt-1'} required maxLength={100} placeholder="Ex.: Chocolate" value={v.nome_var} onChange={e => mudarVariacao(i, { nome_var: e.target.value })} />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <label className="block text-sm">Preço (R$)
              <input className={campo + ' mt-1'} required type="number" min="0.01" max="999999" step="0.01" value={v.preco_var} onChange={e => mudarVariacao(i, { preco_var: e.target.value })} />
            </label>
            <label className="block text-sm">Peso do pote (kg)
              <input className={campo + ' mt-1'} required type="number" min="0.001" max="30" step="0.001" value={v.peso_var} onChange={e => mudarVariacao(i, { peso_var: e.target.value })} />
            </label>
            <label className="block text-sm">Validade (dias)
              <input className={campo + ' mt-1'} required type="number" min="1" max="3650" step="1" value={v.validade_dias_var} onChange={e => mudarVariacao(i, { validade_dias_var: e.target.value })} />
            </label>
            <label className="block text-sm">Prazo de produção (dias úteis)
              <input className={campo + ' mt-1'} required type="number" min="0" max="365" step="1" value={v.prazo_producao_dias_uteis_var} onChange={e => mudarVariacao(i, { prazo_producao_dias_uteis_var: e.target.value })} />
            </label>
            <label className="block text-sm">Estoque físico total
              <input className={campo + ' mt-1'} required type="number" min={v.reservada_est} max="1000000" step="1" value={v.quantidade_est} onChange={e => mudarVariacao(i, { quantidade_est: e.target.value })} />
            </label>
            <p className="text-sm text-stone-600 self-center">Reservadas: <strong>{v.reservada_est}</strong><br />Disponíveis após salvar: <strong>{Math.max(0, Number(v.quantidade_est) - v.reservada_est)}</strong></p>
          </div>
          <p className="text-xs text-stone-500">O estoque físico inclui as unidades reservadas. Informe o total existente, não apenas a reposição.</p>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex gap-2 items-center"><input type="checkbox" checked={v.ativo_var} onChange={e => mudarVariacao(i, { ativo_var: e.target.checked })} /> Variação ativa</label>
            <label className="flex gap-2 items-center"><input type="checkbox" checked={v.tem_lactose_var} onChange={e => mudarVariacao(i, { tem_lactose_var: e.target.checked })} /> Contém lactose</label>
            <label className="flex gap-2 items-center"><input type="checkbox" checked={v.tem_gluten_var} onChange={e => mudarVariacao(i, { tem_gluten_var: e.target.checked })} /> Contém glúten</label>
          </div>
        </div>)}
        <button type="submit" disabled={recortePendente || enviandoFoto} className={botao + ' w-full bg-emerald-700 text-white py-3'}>{ocupado && <Loader2 className="w-4 h-4 animate-spin" />} Salvar produto e variações</button>
      </fieldset>
    </form> : <>
      <label className="block text-sm">Buscar por nome ou número
        <input className={campo + ' mt-1'} type="search" value={busca} onChange={e => setBusca(e.target.value)} />
      </label>
      {excluir && <div role="alertdialog" aria-labelledby="confirmar-exclusao" className="border border-red-200 bg-red-50 rounded-xl p-4 space-y-3">
        <h3 id="confirmar-exclusao" className="font-bold text-red-900">Excluir “{excluir.nome_prd}”?</h3>
        <p className="text-sm text-red-800">A exclusão é definitiva e remove as variações e seus saldos. Produtos com pedidos, reservas ou outros vínculos não podem ser excluídos. Para retirá-los da loja, use Editar e desmarque Produto ativo.</p>
        <div className="flex flex-wrap gap-2"><button className={botao} disabled={ocupado} onClick={() => setExcluir(null)}>Cancelar</button><button className={botao + ' bg-red-700 text-white'} disabled={ocupado} onClick={() => void confirmarExclusao()}>Confirmar exclusão</button></div>
      </div>}
      {carregando ? <p role="status" className="flex gap-2 items-center py-6"><Loader2 className="w-5 h-5 animate-spin" /> Carregando produtos...</p> : filtrados.length === 0 ? <p className="py-6 text-stone-500">Nenhum produto encontrado.</p> :
        <div className="space-y-3">{filtrados.map(p => <article key={p.id_prd} className="border border-stone-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div><h3 className="font-bold">#{p.id_prd} · {p.nome_prd}</h3><p className={`text-sm ${p.ativo_prd ? 'text-emerald-700' : 'text-stone-500'}`}>{p.ativo_prd ? 'Produto ativo' : 'Produto desativado'} · {p.variacoes.filter(v => v.ativo_var).length} variação(ões) ativa(s)</p></div>
            <div className="flex gap-2"><button className={botao} disabled={bloqueado} onClick={() => abrir(p)}><Pencil className="w-4 h-4" /> Editar</button><button className={botao + ' text-red-700'} disabled={bloqueado} onClick={() => { setExcluir(p); setMensagem(null); }}><Trash2 className="w-4 h-4" /> Excluir</button></div>
          </div>
          <ul className="space-y-1 text-sm text-stone-600">{p.variacoes.map(v => <li key={v.id_var}>{v.nome_var} · {Number(v.preco_var).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} · {Math.max(0, Number(v.quantidade_est) - v.reservada_est)} disponíveis{!v.ativo_var && ' · desativada'}</li>)}</ul>
        </article>)}</div>}
    </>}
  </section>;
}
