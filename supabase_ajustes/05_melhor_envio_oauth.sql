BEGIN;
-- Credenciais atuais são preservadas. Os novos controles são privados.
CREATE TABLE IF NOT EXISTS privado.me_token_controle (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 concluida uuid, trava uuid, trava_ate timestamptz, tentativa_apos timestamptz
);
INSERT INTO privado.me_token_controle(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS privado.me_oauth_pendente (
 estado_hash text PRIMARY KEY CHECK (estado_hash ~ '^[a-f0-9]{64}$'),
 administrador uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 criado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE privado.me_token_controle ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.me_oauth_pendente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON privado.me_token_controle, privado.me_oauth_pendente FROM PUBLIC,anon,authenticated,service_role;
-- Nenhuma credencial fica disponível aos clientes.
ALTER TABLE public.melhor_envio_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.melhor_envio_tokens, public.melhor_envio_oauth_states FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.me_oauth_iniciar(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF privado.eh_admin() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Somente administrador ativo.' USING ERRCODE='42501'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Estado inválido.' USING ERRCODE='22023'; END IF;
 DELETE FROM privado.me_oauth_pendente WHERE criado_em < clock_timestamp()-interval '10 minutes';
 DELETE FROM privado.me_oauth_pendente WHERE administrador=auth.uid();
 INSERT INTO privado.me_oauth_pendente(estado_hash,administrador) VALUES(p_hash,auth.uid());
 RETURN jsonb_build_object('sucesso',true);
END $$;
CREATE OR REPLACE FUNCTION public.me_oauth_consumir(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_admin uuid;
BEGIN
 IF privado.eh_admin() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Somente administrador ativo.' USING ERRCODE='42501'; END IF;
 DELETE FROM privado.me_oauth_pendente WHERE estado_hash=p_hash AND administrador=auth.uid()
 AND criado_em > clock_timestamp()-interval '10 minutes' RETURNING administrador INTO v_admin;
 IF v_admin IS NULL THEN RAISE EXCEPTION 'Autorização expirada, inválida ou já utilizada.' USING ERRCODE='22023'; END IF;
 RETURN v_admin;
END $$;
CREATE OR REPLACE FUNCTION public.me_conexao_admin() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.melhor_envio_tokens%ROWTYPE;
BEGIN
 IF privado.eh_admin() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Somente administrador ativo.' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.melhor_envio_tokens WHERE id='principal';
 RETURN jsonb_build_object('conectado',FOUND,'expira_em',t.expires_at,'atualizado_em',t.updated_at,
 'ambiente','sandbox','expirado',coalesce(t.expires_at<=clock_timestamp(),true));
END $$;

CREATE OR REPLACE FUNCTION public.me_token_reservar(p_modo text DEFAULT 'renovar',p_rejeitado text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c privado.me_token_controle%ROWTYPE; t public.melhor_envio_tokens%ROWTYPE; v_trava uuid;
BEGIN
 IF p_modo IS NULL OR p_modo NOT IN ('renovar','autorizar') THEN RAISE EXCEPTION 'Modo inválido.'; END IF;
 SELECT * INTO c FROM privado.me_token_controle WHERE id FOR UPDATE;
 IF c.trava_ate>clock_timestamp() THEN RETURN jsonb_build_object('estado','aguarde'); END IF;
 SELECT * INTO t FROM public.melhor_envio_tokens WHERE id='principal';
 IF p_modo='renovar' THEN
  IF t.access_token IS NULL OR t.refresh_token IS NULL THEN RETURN jsonb_build_object('estado','reconectar'); END IF;
  IF t.expires_at>clock_timestamp()+interval '5 minutes' AND t.access_token IS DISTINCT FROM p_rejeitado THEN
   RETURN jsonb_build_object('estado','pronto','access_token',t.access_token);
  END IF;
  IF c.tentativa_apos>clock_timestamp() THEN RETURN jsonb_build_object('estado','aguarde'); END IF;
 END IF;
 v_trava:=gen_random_uuid();
 UPDATE privado.me_token_controle SET trava=v_trava,trava_ate=clock_timestamp()+interval '90 seconds' WHERE id;
 RETURN jsonb_build_object('estado','renovar','trava',v_trava,
 'refresh_token',CASE WHEN p_modo='renovar' THEN t.refresh_token END);
END $$;
CREATE OR REPLACE FUNCTION public.me_token_concluir(p_trava uuid,p_access text,p_refresh text,p_expira timestamptz,p_admin uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c privado.me_token_controle%ROWTYPE;
BEGIN
 SELECT * INTO c FROM privado.me_token_controle WHERE id FOR UPDATE;
 IF c.concluida=p_trava AND EXISTS(SELECT 1 FROM public.melhor_envio_tokens WHERE id='principal' AND access_token=p_access AND refresh_token=p_refresh AND expires_at=p_expira) THEN RETURN true; END IF;
 IF p_trava IS NULL OR c.trava IS DISTINCT FROM p_trava OR c.trava_ate<=clock_timestamp() THEN RAISE EXCEPTION 'Operação de credencial expirada.' USING ERRCODE='22023'; END IF;
 IF p_admin IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."Administrador" WHERE auth_user_id=p_admin AND ativo) THEN
  RAISE EXCEPTION 'Administrador sem acesso.' USING ERRCODE='42501'; END IF;
 IF p_access IS NULL OR length(p_access)<1 OR length(p_access)>20000 OR p_refresh IS NULL OR length(p_refresh)<1 OR length(p_refresh)>20000
 OR p_expira IS NULL OR p_expira<=clock_timestamp()+interval '1 minute' OR p_expira>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'Credenciais inválidas.'; END IF;
 INSERT INTO public.melhor_envio_tokens(id,access_token,refresh_token,token_type,expires_at,updated_at)
 VALUES('principal',p_access,p_refresh,'Bearer',p_expira,clock_timestamp())
 ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,
 token_type='Bearer',expires_at=excluded.expires_at,updated_at=excluded.updated_at;
 UPDATE privado.me_token_controle SET concluida=p_trava,trava=NULL,trava_ate=NULL,tentativa_apos=NULL WHERE id;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.me_token_liberar(p_trava uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE privado.me_token_controle SET trava=NULL,trava_ate=NULL,tentativa_apos=clock_timestamp()+interval '30 seconds'
 WHERE id AND trava=p_trava;
$$;
REVOKE ALL ON FUNCTION public.me_oauth_iniciar(text),public.me_oauth_consumir(text),public.me_conexao_admin(),
 public.me_token_reservar(text,text),public.me_token_concluir(uuid,text,text,timestamptz,uuid),public.me_token_liberar(uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.me_oauth_iniciar(text),public.me_oauth_consumir(text),public.me_conexao_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_token_reservar(text,text),public.me_token_concluir(uuid,text,text,timestamptz,uuid),public.me_token_liberar(uuid) TO service_role;
COMMIT;
SELECT has_function_privilege('authenticated','public.me_oauth_iniciar(text)','EXECUTE') AS admin_inicia_com_validacao,
 has_function_privilege('anon','public.me_oauth_iniciar(text)','EXECUTE') AS visitante_inicia,
 has_function_privilege('authenticated','public.me_token_reservar(text,text)','EXECUTE') AS cliente_acessa_tokens,
 has_table_privilege('authenticated','public.melhor_envio_tokens','SELECT') AS cliente_le_tokens;
