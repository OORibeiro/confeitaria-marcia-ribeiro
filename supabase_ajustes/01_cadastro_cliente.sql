-- PACOTE 01: cadastro do próprio cliente pela sessão autenticada.
-- Execute este arquivo inteiro no SQL Editor antes de instalar os arquivos do site.
-- Não altera pedidos, pagamentos, tabelas, políticas RLS ou perfis existentes.
BEGIN;

CREATE OR REPLACE FUNCTION public.garantir_meu_cadastro_cliente()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_usuario uuid := auth.uid();
  v_email text;
  v_metadata jsonb;
  v_nome text;
  v_cpf text;
  v_telefone text;
  v_data_texto text;
  v_nascimento date;
  v_cliente public."Cliente"%ROWTYPE;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Faça login para concluir seu cadastro.' USING ERRCODE = '42501';
  END IF;

  -- O usuário não fornece UUID nem e-mail como parâmetro.
  -- O bloqueio serializa duas solicitações da mesma conta, inclusive entre abas.
  SELECT u.email, coalesce(u.raw_user_meta_data, '{}'::jsonb)
  INTO v_email, v_metadata
  FROM auth.users u
  WHERE u.id = v_usuario
  FOR UPDATE;

  IF NOT FOUND OR nullif(btrim(v_email), '') IS NULL THEN
    RAISE EXCEPTION 'Use uma conta autenticada com e-mail.' USING ERRCODE = '42501';
  END IF;

  SELECT c.* INTO v_cliente
  FROM public."Cliente" c
  WHERE c.auth_user_id = v_usuario;

  IF FOUND THEN
    -- Idempotente: não sobrescreve os dados de quem já tem cadastro.
    RETURN to_jsonb(v_cliente);
  END IF;

  v_email := btrim(v_email);
  v_nome := coalesce(nullif(btrim(v_metadata->>'nome_clt'), ''),
                     nullif(split_part(v_email, '@', 1), ''), 'Cliente');
  v_cpf := nullif(regexp_replace(coalesce(v_metadata->>'cpf_clt', ''), '[^0-9]', '', 'g'), '');
  v_telefone := nullif(btrim(v_metadata->>'telefone_clt'), '');
  v_data_texto := nullif(btrim(v_metadata->>'nascimento_clt'), '');

  IF length(v_nome) > 255 OR length(v_email) > 255 THEN
    RAISE EXCEPTION 'Nome e e-mail devem ter no máximo 255 caracteres.' USING ERRCODE = '22023';
  END IF;
  IF v_cpf IS NOT NULL AND v_cpf !~ '^[0-9]{11}$' THEN
    RAISE EXCEPTION 'Informe um CPF com 11 números ou deixe o campo vazio.' USING ERRCODE = '22023';
  END IF;
  IF length(v_telefone) > 20 THEN
    RAISE EXCEPTION 'O telefone deve ter no máximo 20 caracteres.' USING ERRCODE = '22023';
  END IF;
  IF v_data_texto IS NOT NULL THEN
    IF v_data_texto !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Data de nascimento inválida.' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_nascimento := v_data_texto::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Data de nascimento inválida.' USING ERRCODE = '22023';
    END;
    IF v_nascimento > current_date THEN
      RAISE EXCEPTION 'A data de nascimento não pode estar no futuro.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Metadados servem apenas ao perfil do próprio cliente, nunca à autorização.
  -- Conflitos com cadastros antigos não vinculados precisam de revisão manual.
  -- Não associar automaticamente um cadastro preexistente por e-mail ou CPF.
  BEGIN
    INSERT INTO public."Cliente" (
      auth_user_id, nome_clt, email_clt, cpf_clt, telefone_clt, nascimento_clt
    ) VALUES (
      v_usuario, v_nome, v_email, v_cpf, v_telefone, v_nascimento
    ) RETURNING * INTO v_cliente;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Não foi possível concluir o cadastro. Entre em contato com a loja para revisar seus dados.'
      USING ERRCODE = '23505';
  END;

  RETURN to_jsonb(v_cliente);
END;
$function$;

REVOKE ALL ON FUNCTION public.garantir_meu_cadastro_cliente()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.garantir_meu_cadastro_cliente() TO authenticated;

COMMENT ON FUNCTION public.garantir_meu_cadastro_cliente() IS
  'Cria somente o perfil do usuário autenticado, se ausente; preserva cadastros existentes.';

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Resultado esperado: autenticado_permitido = true; visitante_permitido = false.
SELECT
  has_function_privilege('authenticated', 'public.garantir_meu_cadastro_cliente()', 'EXECUTE') AS autenticado_permitido,
  has_function_privilege('anon', 'public.garantir_meu_cadastro_cliente()', 'EXECUTE') AS visitante_permitido;
