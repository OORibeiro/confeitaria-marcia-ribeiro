-- Requer os pacotes 01, 02 e 03. Não executa expiração durante a instalação.
BEGIN;
CREATE TABLE IF NOT EXISTS privado."Execucao_Expiracao_Reserva" (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 iniciada_em timestamptz NOT NULL, concluida_em timestamptz NOT NULL,
 pedidos_examinados integer NOT NULL, pedidos_expirados integer NOT NULL,
 reservas_expiradas integer NOT NULL, falhas integer NOT NULL
);
CREATE INDEX IF NOT EXISTS execucao_expiracao_data ON privado."Execucao_Expiracao_Reserva"(iniciada_em);
CREATE TABLE IF NOT EXISTS privado."Falha_Expiracao_Reserva" (
 pedido_id integer PRIMARY KEY REFERENCES public."Pedido"(id_pdd) ON DELETE CASCADE,
 ultima_tentativa timestamptz NOT NULL, tentativas integer NOT NULL DEFAULT 1,
 codigo_erro text NOT NULL, mensagem_erro text NOT NULL
);
ALTER TABLE privado."Execucao_Expiracao_Reserva" ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado."Falha_Expiracao_Reserva" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON privado."Execucao_Expiracao_Reserva",privado."Falha_Expiracao_Reserva" FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION privado.processar_reservas_vencidas(p_limite integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE
 v_pedido record; v_estoque record; v_linhas integer;
 v_examinados integer:=0; v_expirados integer:=0; v_reservas integer:=0; v_falhas integer:=0;
 v_inicio timestamptz:=clock_timestamp(); v_codigo text; v_mensagem text;
BEGIN
 IF p_limite IS NULL OR p_limite NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Limite inválido.' USING ERRCODE='22023'; END IF;
 -- Serializa chamadas de tarefas diferentes, além de SKIP LOCKED nos pedidos.
 IF NOT pg_try_advisory_xact_lock(705071,1) THEN
  RETURN jsonb_build_object('em_execucao',true,'pedidos_expirados',0);
 END IF;
 FOR v_pedido IN
  SELECT p.id_pdd FROM public."Pedido" p
  WHERE p.status_pdd='pendente'
    AND EXISTS(SELECT 1 FROM public."Reserva_Estoque" r WHERE r.id_pdd_fk=p.id_pdd AND r.status_res='reservada' AND r.expira_em<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM public."Reserva_Estoque" r WHERE r.id_pdd_fk=p.id_pdd
      AND (r.status_res='confirmada' OR r.status_res='reservada' AND r.expira_em>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM public."Pagamento" pg WHERE pg.id_pdd_fk=p.id_pdd AND (pg.status_pag='aprovado' OR pg.pago_em IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public."Venda" v WHERE v.id_pdd_fk=p.id_pdd AND v.status_vnd='aprovado')
    AND NOT EXISTS(SELECT 1 FROM privado."Falha_Expiracao_Reserva" f WHERE f.pedido_id=p.id_pdd AND f.ultima_tentativa>clock_timestamp()-interval '10 minutes')
  ORDER BY p.id_pdd LIMIT p_limite FOR UPDATE OF p SKIP LOCKED
 LOOP
  v_examinados:=v_examinados+1;
  BEGIN
   -- Mesma ordem de bloqueio das variações usada pelas rotinas de estoque.
   FOR v_estoque IN
    SELECT e.* FROM public."Estoque" e
    WHERE EXISTS(SELECT 1 FROM public."Reserva_Estoque" r WHERE r.id_pdd_fk=v_pedido.id_pdd
      AND r.id_prd_fk=e.id_prd_fk AND r.id_var_fk=e.id_var_fk AND r.status_res='reservada')
    ORDER BY e.id_prd_fk,e.id_var_fk FOR UPDATE OF e
   LOOP
    IF v_estoque.reservada_est IS DISTINCT FROM
      (SELECT coalesce(sum(r.quantidade_res),0) FROM public."Reserva_Estoque" r
       WHERE r.id_prd_fk=v_estoque.id_prd_fk AND r.id_var_fk=v_estoque.id_var_fk AND r.status_res='reservada') THEN
     RAISE EXCEPTION 'Saldo reservado inconsistente; é necessária revisão de estoque.' USING ERRCODE='23514';
    END IF;
   END LOOP;
   v_linhas:=privado.liberar_reserva_pedido(v_pedido.id_pdd,'expirada');
   IF v_linhas>0 THEN
    UPDATE public."Pedido" SET status_pdd='expirado' WHERE id_pdd=v_pedido.id_pdd;
    v_expirados:=v_expirados+1; v_reservas:=v_reservas+v_linhas;
   END IF;
   DELETE FROM privado."Falha_Expiracao_Reserva" WHERE pedido_id=v_pedido.id_pdd;
  EXCEPTION WHEN OTHERS THEN
   -- O subbloco desfaz somente as alterações deste pedido.
   GET STACKED DIAGNOSTICS v_codigo=RETURNED_SQLSTATE,v_mensagem=MESSAGE_TEXT;
   INSERT INTO privado."Falha_Expiracao_Reserva"(pedido_id,ultima_tentativa,codigo_erro,mensagem_erro)
   VALUES(v_pedido.id_pdd,clock_timestamp(),v_codigo,left(v_mensagem,500))
   ON CONFLICT(pedido_id) DO UPDATE SET ultima_tentativa=excluded.ultima_tentativa,
    tentativas=privado."Falha_Expiracao_Reserva".tentativas+1,codigo_erro=excluded.codigo_erro,mensagem_erro=excluded.mensagem_erro;
   v_falhas:=v_falhas+1;
  END;
 END LOOP;
 INSERT INTO privado."Execucao_Expiracao_Reserva"(iniciada_em,concluida_em,pedidos_examinados,pedidos_expirados,reservas_expiradas,falhas)
 VALUES(v_inicio,clock_timestamp(),v_examinados,v_expirados,v_reservas,v_falhas);
 DELETE FROM privado."Execucao_Expiracao_Reserva" WHERE iniciada_em<clock_timestamp()-interval '30 days';
 RETURN jsonb_build_object('em_execucao',false,'pedidos_examinados',v_examinados,
  'pedidos_expirados',v_expirados,'reservas_expiradas',v_reservas,'falhas',v_falhas);
END $fn$;
-- Mantém assinatura e retorno usados por eventuais agendamentos anteriores.
CREATE OR REPLACE FUNCTION privado.expirar_reservas_vencidas() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_resultado jsonb;
BEGIN
 v_resultado:=privado.processar_reservas_vencidas(100);
 RETURN (v_resultado->>'pedidos_expirados')::integer;
END $fn$;
REVOKE ALL ON FUNCTION privado.processar_reservas_vencidas(integer),privado.expirar_reservas_vencidas() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.consultar_checkout_cliente(
  p_pedido_id integer DEFAULT NULL, p_chave_solicitacao uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_cliente integer; v_pedido integer; v_status text; v_base jsonb;
  v_pg public."Pagamento"%ROWTYPE; v_qtd integer;
  v_expira timestamptz; v_estado text; v_chave uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Faça login para consultar seu pedido.' USING ERRCODE='42501'; END IF;
  SELECT id_clt INTO v_cliente FROM public."Cliente" WHERE auth_user_id=auth.uid() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cadastro não encontrado.' USING ERRCODE='42501'; END IF;
  IF p_pedido_id IS NULL AND p_chave_solicitacao IS NULL THEN
    RAISE EXCEPTION 'Informe o pedido ou a tentativa que deseja recuperar.' USING ERRCODE='22023';
  END IF;
  IF p_chave_solicitacao IS NOT NULL THEN
    SELECT id_pdd_fk,chave_solicitacao INTO v_pedido,v_chave FROM privado."Tentativa_Checkout_Cliente"
      WHERE id_clt_fk=v_cliente AND chave_solicitacao=p_chave_solicitacao;
    IF NOT FOUND THEN RETURN jsonb_build_object('encontrado',false); END IF;
    IF p_pedido_id IS NOT NULL AND p_pedido_id <> v_pedido THEN
      RAISE EXCEPTION 'Tentativa e pedido incompatíveis.' USING ERRCODE='42501';
    END IF;
  ELSE v_pedido:=p_pedido_id;
  END IF;
  SELECT status_pdd INTO v_status FROM public."Pedido"
    WHERE id_pdd=v_pedido AND id_clt_fk=v_cliente FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado ou sem acesso.' USING ERRCODE='42501'; END IF;
  v_base:=public.consultar_acompanhamento_pedido(v_pedido);
  SELECT count(*) INTO v_qtd FROM public."Pagamento" WHERE id_pdd_fk=v_pedido;
  IF v_qtd=1 THEN SELECT * INTO v_pg FROM public."Pagamento" WHERE id_pdd_fk=v_pedido; END IF;
  SELECT min(expira_em) INTO v_expira FROM public."Reserva_Estoque" WHERE id_pdd_fk=v_pedido;
  IF v_qtd>1 THEN v_estado:='em_analise';
  ELSIF v_pg.status_pag='aprovado' AND v_status IN ('pago','em_producao','pronto','enviado','entregue') THEN v_estado:='aprovado';
  ELSIF EXISTS(SELECT 1 FROM public."Notificacao_Pagamento" n WHERE n.id_pag_fk=v_pg.id_pag AND n.status_not='analise_manual')
    THEN v_estado:='em_analise';
  ELSIF v_status='expirado' AND coalesce(v_pg.status_pag,'pendente') IN ('pendente','expirado')
    AND v_expira<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM public."Reserva_Estoque" WHERE id_pdd_fk=v_pedido AND status_res<>'expirada')
    THEN v_estado:='expirado';
  ELSIF v_pg.status_pag='aprovado' OR v_status<>'pendente' THEN v_estado:='em_analise';
  ELSIF v_pg.status_pag IS NOT NULL AND v_pg.status_pag<>'pendente' THEN v_estado:='em_analise';
  ELSIF v_pg.pix_expira_em <= clock_timestamp() OR v_expira <= clock_timestamp() THEN v_estado:='expirado';
  ELSIF v_expira IS NULL OR EXISTS (SELECT 1 FROM public."Reserva_Estoque"
    WHERE id_pdd_fk=v_pedido AND status_res<>'reservada') THEN v_estado:='em_analise';
  ELSIF v_pg.identificador_gateway_pag IS NULL THEN v_estado:='aguardando_pix';
  ELSE v_estado:='pendente'; END IF;
  RETURN v_base || jsonb_build_object('encontrado',true,'estado',v_estado,
    'total',coalesce((v_base->>'total')::numeric,
      (SELECT sum(subtotal_item) FROM public."Item_Pedido" WHERE id_pdd_fk=v_pedido)+(v_base->>'frete')::numeric),
    'chave_solicitacao',v_chave,'pagamento_id',v_pg.id_pag,'status_pagamento',v_pg.status_pag,
    'order_id',v_pg.identificador_gateway_pag,'pix_expira_em',v_pg.pix_expira_em,
    'reserva_expira_em',v_expira,'data_servidor',clock_timestamp(),'ambiente',v_pg.ambiente_pag);
END; $fn$;
REVOKE ALL ON FUNCTION public.consultar_checkout_cliente(integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.consultar_checkout_cliente(integer,uuid) TO authenticated;


COMMIT;
SELECT has_function_privilege('authenticated','privado.expirar_reservas_vencidas()','EXECUTE') AS cliente_expira_reservas,
 has_function_privilege('anon','privado.processar_reservas_vencidas(integer)','EXECUTE') AS visitante_expira_reservas;
