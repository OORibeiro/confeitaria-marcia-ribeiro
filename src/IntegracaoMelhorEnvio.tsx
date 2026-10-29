import { useEffect, useRef, useState } from 'react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

const markerKey = 'mr.melhorenvio.oauth.v5';
export default function IntegracaoMelhorEnvio() {
  const [conexao, setConexao] = useState<any>(null);
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState('');
  const [erro, setErro] = useState('');
  const executando = useRef(false);
  const montado = useRef(true);
  const iniciou = useRef(false);
  useEffect(() => {
    montado.current = true;
    if (!iniciou.current) { iniciou.current = true; void recuperar(); }
    return () => { montado.current = false; };
  }, []);

  async function sessao() {
    if (!supabase) throw new Error('Conexão indisponível.');
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error('Entre novamente com sua conta administradora.');
    return data.session;
  }
  async function chamar(nome: string, body: unknown, token: string) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${nome}`, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.sucesso) throw new Error(data?.error || 'Não foi possível atualizar a conexão.');
    return data;
  }
  async function carregar() {
    const { data, error } = await supabase!.rpc('me_conexao_admin');
    if (error) throw new Error(error.message);
    if (montado.current) setConexao(data);
  }
  async function operar(fn: () => Promise<void>) {
    if (executando.current) return;
    executando.current = true; setOcupado(true); setErro('');
    try { await fn(); }
    catch (e: any) { if (montado.current) setErro(e.name === 'TimeoutError' ? 'A resposta demorou. Consulte a conexão antes de iniciar outra autorização.' : e.message || 'Não foi possível concluir.'); }
    finally { executando.current = false; if (montado.current) setOcupado(false); }
  }
  async function recuperar() {
    await operar(async () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const retorno = hash.has('me_state') || hash.has('me_code') || hash.has('me_erro');
      if (retorno) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (hash.has('me_erro')) {
        sessionStorage.removeItem(markerKey);
        throw new Error('A autorização foi cancelada ou recusada. Você pode conectar novamente.');
      }
      if (retorno) {
        const s = await sessao();
        let marker: any;
        try { marker = JSON.parse(sessionStorage.getItem(markerKey) || 'null'); } catch { /* estado ausente */ }
        sessionStorage.removeItem(markerKey);
        if (!marker || marker.userId !== s.user.id || marker.state !== hash.get('me_state')
          || !Number.isFinite(marker.criado) || Date.now() - marker.criado > 10 * 60000 || marker.criado > Date.now() + 60000) {
          throw new Error('Este retorno não corresponde à autorização iniciada nesta aba. Conecte novamente.');
        }
        const result = await chamar('melhor-envio-callback', { state: marker.state, code: hash.get('me_code') }, s.access_token);
        if (montado.current) setMensagem(result.mensagem);
      }
      await carregar();
    });
  }
  async function conectar() {
    await operar(async () => {
      const s = await sessao();
      const result = await chamar('melhor-envio-iniciar', {}, s.access_token);
      const u = new URL(result.url);
      if (u.origin !== 'https://sandbox.melhorenvio.com.br' || u.pathname !== '/oauth/authorize'
        || !/^[a-f0-9]{64}$/.test(result.state) || u.searchParams.get('state') !== result.state) throw new Error('Endereço de autorização inválido.');
      // Se o armazenamento da aba estiver bloqueado, não inicia um fluxo irrecuperável.
      sessionStorage.setItem(markerKey, JSON.stringify({ state: result.state, userId: s.user.id, criado: Date.now() }));
      window.location.assign(u.toString());
    });
  }
  return <div className="max-w-2xl mx-auto space-y-4">
    <h2 className="text-xl font-serif font-bold">Conexão com o Melhor Envio</h2>
    <p className="text-sm text-stone-600">Ambiente de testes (sandbox). A renovação é automática ao calcular o frete quando o token estiver próximo do vencimento.</p>
    {conexao && <div className="border rounded-xl p-4 text-sm space-y-2">
      <p className="font-semibold">{!conexao.conectado ? 'Não conectado' : conexao.expirado ? 'Token vencido — a próxima cotação tentará renovar' : 'Conectado'}</p>
      {conexao.expira_em && <p>Validade do acesso: {new Date(conexao.expira_em).toLocaleString('pt-BR')}</p>}
      {conexao.atualizado_em && <p>Última atualização: {new Date(conexao.atualizado_em).toLocaleString('pt-BR')}</p>}
    </div>}
    <p className="text-sm text-stone-600">Se a autorização for revogada ou ficar mais de 45 dias sem renovação, conecte novamente. Apenas administradores ativos podem autorizar esta integração.</p>
    {mensagem && <p role="status" className="p-3 bg-emerald-50 text-emerald-800 rounded-xl">{mensagem}</p>}
    {erro && <p role="alert" className="p-3 bg-red-50 text-red-800 rounded-xl">{erro}</p>}
    <div className="flex flex-wrap gap-3">
      <button disabled={ocupado} onClick={() => void conectar()} className="px-4 py-3 rounded-xl bg-amber-500 text-stone-900 font-semibold disabled:opacity-40">{ocupado ? 'Aguarde…' : 'Conectar / autorizar novamente'}</button>
      <button disabled={ocupado} onClick={() => void operar(carregar)} className="px-4 py-3 rounded-xl bg-stone-100 disabled:opacity-40">Consultar conexão</button>
    </div>
  </div>;
}
