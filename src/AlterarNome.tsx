import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export default function AlterarNome({ usuarioId, nomeAtual, onSalvo }: {
  usuarioId: string; nomeAtual: string; onSalvo: (nome: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState(nomeAtual);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const ativo = useRef(true);
  const ocupado = useRef(false);
  useEffect(() => { ativo.current = true; return () => { ativo.current = false; }; }, []);
  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (ocupado.current) return;
    const normalizado = nome.trim().replace(/\s+/g, ' ');
    if (!normalizado || normalizado.length > 255) {
      setErro('Informe um nome com até 255 caracteres.'); return;
    }
    ocupado.current = true; setSalvando(true); setErro(''); setSucesso('');
    try {
      if (!supabase) throw new Error('Conexão indisponível.');
      const { data, error } = await supabase.rpc('mr_alterar_meu_nome', { p_nome: normalizado });
      if (error) throw new Error('Não foi possível salvar o nome. Tente novamente.');
      const sessao = await supabase.auth.getSession();
      if (!ativo.current || sessao.data.session?.user.id !== usuarioId) return;
      if (data?.auth_user_id !== usuarioId || typeof data.nome_clt !== 'string') {
        throw new Error('Não foi possível confirmar a alteração. Atualize a página.');
      }
      onSalvo(data.nome_clt); setAberto(false); setSucesso('Nome atualizado.');
    } catch (e) {
      if (ativo.current) setErro(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      ocupado.current = false;
      if (ativo.current) setSalvando(false);
    }
  }
  return <div>
    <button type="button" aria-expanded={aberto} aria-controls="editar-nome"
      className="inline-flex items-center justify-center rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 transition-colors hover:border-amber-800 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" 
      onClick={() => { setAberto(a => !a); setNome(nomeAtual); setErro(''); setSucesso(''); }}
      disabled={salvando}>Alterar nome</button>
    {sucesso && <p role="status" className="mt-2 text-xs text-emerald-800">{sucesso}</p>}
    {aberto && <form id="editar-nome" onSubmit={salvar} className="mt-3 space-y-2 w-full max-w-sm">
      <label htmlFor="nome-perfil" className="block text-sm font-medium">Nome da conta</label>
      <input id="nome-perfil" autoComplete="name" required maxLength={255} value={nome}
        disabled={salvando} onChange={e => setNome(e.target.value)}
        className="w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2 text-sm focus:ring-2 focus:ring-amber-700" />
      {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={salvando} className="rounded-lg bg-amber-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{salvando ? 'Salvando…' : 'Salvar nome'}</button>
        <button type="button" disabled={salvando} onClick={() => { setAberto(false); setErro(''); }} className="rounded-lg border px-3 py-2 text-sm">Cancelar</button>
      </div>
    </form>}
  </div>;
}
