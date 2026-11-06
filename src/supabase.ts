import { createClient } from '@supabase/supabase-js';

// Capture o retorno antes que o SDK consuma e remova os parâmetros de autenticação.
const parametrosSenha = new URLSearchParams(window.location.hash.slice(1));
export const retornoSenha = {
  solicitado: new URLSearchParams(window.location.search).get('redefinir') === '1' || parametrosSenha.get('type') === 'recovery',
  tokenRecuperacao: parametrosSenha.get('type') === 'recovery',
  erro: parametrosSenha.has('error') || parametrosSenha.has('error_code'),
};

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://wjyoharjddlnwhhmfawu.supabase.co';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== 'COLE_AQUI_SUA_CHAVE_PUBLICA_ANON_KEY');

export const supabase = supabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

