BEGIN;
CREATE OR REPLACE FUNCTION public.mr_alterar_meu_nome(p_nome text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nome text := btrim(regexp_replace(p_nome, '\s+', ' ', 'g'));
  v_id integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Faça login para alterar seu nome.' USING ERRCODE = '42501';
  END IF;
  IF v_nome IS NULL OR char_length(v_nome) < 1 OR char_length(v_nome) > 255 THEN
    RAISE EXCEPTION 'Informe um nome com até 255 caracteres.' USING ERRCODE = '22023';
  END IF;
  UPDATE public."Cliente" SET nome_clt = v_nome
  WHERE auth_user_id = v_uid RETURNING id_clt INTO v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cadastro não encontrado.' USING ERRCODE = 'P0002';
  END IF;
  -- Mantém o nome usado pelo cadastro sincronizado, preservando as demais informações.
  UPDATE auth.users SET raw_user_meta_data =
    coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('nome_clt', v_nome)
  WHERE id = v_uid;
  RETURN jsonb_build_object('id_clt', v_id, 'auth_user_id', v_uid, 'nome_clt', v_nome);
END;
$$;
REVOKE ALL ON FUNCTION public.mr_alterar_meu_nome(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mr_alterar_meu_nome(text) TO authenticated;
COMMIT;
