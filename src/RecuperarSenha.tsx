import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export default function RecuperarSenha({ modo, autorizado, verificando, emailInicial, aoVoltar }: {
  modo: 'solicitar' | 'redefinir'; autorizado: boolean; verificando: boolean;
  emailInicial: string; aoVoltar: () => void;
}) {
  const [email, setEmail] = useState(emailInicial);
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [concluido, setConcluido] = useState(false);
  const [espera, setEspera] = useState(0);
  const trava = useRef(false);
  const vivo = useRef(true);
  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);
  useEffect(() => {
    if (!espera) return;
    const timer = window.setTimeout(() => setEspera(n => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [espera]);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || trava.current || (modo === 'solicitar' && espera)) return;
    setErro(''); setMensagem('');
    if (modo === 'redefinir') {
      if (!autorizado) { setErro('Abra um novo link de recuperação enviado para seu e-mail.'); return; }
      if (senha.length < 8) { setErro('Use uma senha com pelo menos 8 caracteres.'); return; }
      if (senha !== confirmacao) { setErro('As senhas não coincidem.'); return; }
    }
    trava.current = true; setOcupado(true);
    try {
      if (modo === 'solicitar') {
        const destino = new URL(window.location.pathname, window.location.origin);
        destino.searchParams.set('redefinir', '1');
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: destino.toString() });
        if (error) throw new Error(error.status === 429
          ? 'Muitas solicitações. Aguarde alguns minutos antes de tentar novamente.'
          : 'Não foi possível solicitar a recuperação agora. Tente novamente mais tarde.');
        if (vivo.current) {
          setMensagem('Se este e-mail estiver cadastrado, você receberá um link para redefinir sua senha. Confira também a pasta de spam.');
          setEspera(60);
        }
      } else {
        const { error } = await supabase.auth.updateUser({ password: senha });
        if (error) throw new Error(error.code === 'same_password'
          ? 'Escolha uma senha diferente da anterior.'
          : error.code === 'weak_password' ? 'A senha não atende às regras de segurança. Use uma senha mais forte.'
          : 'Não foi possível alterar a senha. O link pode ter expirado; solicite um novo e tente novamente.');
        try { sessionStorage.removeItem('mr.recuperacao.usuario'); } catch {}
        if (vivo.current) {
          setSenha(''); setConfirmacao(''); setConcluido(true);
          setMensagem('Senha alterada com sucesso. Use a nova senha no próximo acesso.');
        }
      }
    } catch (e) {
      if (vivo.current) setErro(e instanceof Error ? e.message : 'Não foi possível concluir a operação.');
    } finally {
      trava.current = false;
      if (vivo.current) setOcupado(false);
    }
  }
  const campo = 'mt-1 w-full rounded-xl border border-stone-300 px-4 py-3 text-sm';
  return <section className="mx-auto max-w-md space-y-5 rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
    <h1 className="font-serif text-2xl font-bold">{modo === 'solicitar' ? 'Recuperar senha' : 'Definir nova senha'}</h1>
    {erro && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{erro}</p>}
    {mensagem && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{mensagem}</p>}
    {modo === 'redefinir' && verificando ? <p role="status">Verificando o link…</p>
      : modo === 'redefinir' && !autorizado && !concluido ? <div className="space-y-3">
        <p role="alert" className="text-sm text-stone-600">Este link está inválido, expirou ou a sessão foi encerrada. Solicite um novo link de recuperação.</p>
        <button type="button" onClick={aoVoltar} className="font-semibold text-amber-900 underline">Voltar ao perfil para solicitar outro link</button>
      </div> : !concluido && <form onSubmit={enviar} className="space-y-4">
        <fieldset disabled={ocupado} className="space-y-4">
          {modo === 'solicitar' ? <>
            <p className="text-sm text-stone-600">Informe o e-mail da sua conta. Enviaremos um link para você escolher uma nova senha.</p>
            <label className="block text-sm font-semibold">E-mail da conta
              <input type="email" required autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} className={campo} />
            </label>
          </> : <>
            <label className="block text-sm font-semibold">Nova senha
              <input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={senha} onChange={e => setSenha(e.target.value)} className={campo} />
            </label>
            <label className="block text-sm font-semibold">Confirmar nova senha
              <input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={confirmacao} onChange={e => setConfirmacao(e.target.value)} className={campo} />
            </label>
            <p className="text-xs text-stone-500">Use pelo menos 8 caracteres. Prefira uma senha longa e exclusiva para esta conta.</p>
          </>}
          <button type="submit" disabled={ocupado || !supabase || espera > 0}
            className="w-full rounded-xl bg-amber-800 px-4 py-3 font-semibold text-white disabled:opacity-50">
            {ocupado ? 'Aguarde…' : espera ? 'Enviar novamente em ' + espera + 's' : modo === 'solicitar' ? 'Enviar link de recuperação' : 'Salvar nova senha'}
          </button>
        </fieldset>
      </form>}
    {!(modo === 'redefinir' && !autorizado && !concluido) && <button type="button" disabled={ocupado}
      onClick={aoVoltar} className="text-sm font-semibold text-amber-900 underline">{concluido ? 'Ir para meu perfil' : 'Voltar ao perfil'}</button>}
  </section>;
}
