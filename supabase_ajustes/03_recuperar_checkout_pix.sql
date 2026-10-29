-- PACOTE 03. Requer os pacotes 01 e 02 instalados.
BEGIN;
CREATE TABLE IF NOT EXISTS privado."Tentativa_Checkout_Cliente" (
  id_clt_fk integer NOT NULL REFERENCES public."Cliente"(id_clt) ON DELETE RESTRICT,
  chave_solicitacao uuid NOT NULL,
  id_pdd_fk integer NOT NULL REFERENCES public."Pedido"(id_pdd) ON DELETE RESTRICT,
  cotacao_id uuid NOT NULL REFERENCES privado."Cotacao_Frete"(id) ON DELETE RESTRICT,
  conteudo jsonb NOT NULL CHECK (jsonb_typeof(conteudo) = 'object'),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id_clt_fk,chave_solicitacao)
);
CREATE INDEX IF NOT EXISTS tentativa_checkout_cliente_cotacao
 ON privado."Tentativa_Checkout_Cliente"(id_clt_fk,cotacao_id);
ALTER TABLE privado."Tentativa_Checkout_Cliente" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON privado."Tentativa_Checkout_Cliente" FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public."Pagamento" ADD COLUMN IF NOT EXISTS pix_expira_em timestamptz;

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

CREATE OR REPLACE FUNCTION public.iniciar_checkout_cliente(
  p_chave_solicitacao uuid,p_endereco jsonb,p_itens jsonb,p_cotacao_id uuid,p_servico_id integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_cliente integer; v_pedido integer; v_endereco integer; v_anterior jsonb;
  v_addr jsonb; v_itens jsonb; v_conteudo jsonb; v_item jsonb; v_criado jsonb;
  v_campo text; v_novo boolean:=false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Faça login para continuar.' USING ERRCODE='42501'; END IF;
  IF p_chave_solicitacao IS NULL OR p_cotacao_id IS NULL OR p_servico_id IS NULL THEN
    RAISE EXCEPTION 'Informe a tentativa e a cotação de frete.' USING ERRCODE='22023';
  END IF;
  IF p_endereco IS NULL OR jsonb_typeof(p_endereco) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Informe seu endereço de entrega.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_endereco) x(k)
    WHERE k NOT IN ('logradouro','numero','complemento','bairro','cidade','estado','cep')) THEN
    RAISE EXCEPTION 'O endereço contém campos inválidos.' USING ERRCODE='22023';
  END IF;
  FOREACH v_campo IN ARRAY ARRAY['logradouro','numero','bairro','cidade','estado','cep'] LOOP
    IF jsonb_typeof(p_endereco->v_campo) IS DISTINCT FROM 'string'
      OR nullif(btrim(p_endereco->>v_campo),'') IS NULL THEN
      RAISE EXCEPTION 'Preencha todos os campos obrigatórios do endereço.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF p_endereco->>'complemento' IS NOT NULL AND jsonb_typeof(p_endereco->'complemento')<>'string' THEN
    RAISE EXCEPTION 'Complemento inválido.' USING ERRCODE='22023';
  END IF;
  v_addr:=jsonb_build_object('logradouro',btrim(p_endereco->>'logradouro'),'numero',btrim(p_endereco->>'numero'),
    'complemento',nullif(btrim(p_endereco->>'complemento'),''),'bairro',btrim(p_endereco->>'bairro'),
    'cidade',btrim(p_endereco->>'cidade'),'estado',upper(btrim(p_endereco->>'estado')),
    'cep',regexp_replace(p_endereco->>'cep','[-[:space:]]','','g'));
  IF length(v_addr->>'logradouro')>150 OR length(v_addr->>'numero')>15 OR length(v_addr->>'complemento')>50
    OR length(v_addr->>'bairro')>100 OR length(v_addr->>'cidade')>100
    OR (v_addr->>'estado') !~ '^[A-Z]{2}$' OR (v_addr->>'cep') !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'Confira o endereço, o CEP e os limites dos campos.' USING ERRCODE='22023';
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Informe os itens do pedido.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_itens) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'O pedido deve ter entre 1 e 10 potes.' USING ERRCODE='22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_itens) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Item inválido.' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) x(k) WHERE k NOT IN ('produto_id','variacao_id','quantidade'))
      OR jsonb_typeof(v_item->'produto_id') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_item->'variacao_id') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_item->'quantidade') IS DISTINCT FROM 'number'
      OR coalesce(v_item->>'produto_id','') !~ '^[1-9][0-9]{0,9}$'
      OR coalesce(v_item->>'variacao_id','') !~ '^[1-9][0-9]{0,9}$'
      OR coalesce(v_item->>'quantidade','') !~ '^[1-9][0-9]?$' THEN
      RAISE EXCEPTION 'Item inválido. Envie apenas produto, variação e quantidade.' USING ERRCODE='22023';
    END IF;
    IF (v_item->>'produto_id')::numeric>2147483647 OR (v_item->>'variacao_id')::numeric>2147483647 THEN
      RAISE EXCEPTION 'Produto ou variação inválida.' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT sum((x->>'quantidade')::integer) FROM jsonb_array_elements(p_itens) x)>10 THEN
    RAISE EXCEPTION 'O limite é de 10 potes por pedido.' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(jsonb_build_object('produto_id',pid,'variacao_id',vid,'quantidade',qtd) ORDER BY pid,vid) INTO v_itens
  FROM (SELECT (x->>'produto_id')::integer pid,(x->>'variacao_id')::integer vid,
    sum((x->>'quantidade')::integer)::integer qtd FROM jsonb_array_elements(p_itens) x GROUP BY 1,2) t;
  v_conteudo:=jsonb_build_object('endereco',v_addr,'itens',v_itens,'cotacao_id',p_cotacao_id,'servico_id',p_servico_id);
  -- Todas as tentativas desta conta são serializadas, inclusive entre abas.
  SELECT id_clt INTO v_cliente FROM public."Cliente" WHERE auth_user_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conclua seu cadastro antes de comprar.' USING ERRCODE='42501'; END IF;
  SELECT id_pdd_fk,conteudo INTO v_pedido,v_anterior FROM privado."Tentativa_Checkout_Cliente"
    WHERE id_clt_fk=v_cliente AND chave_solicitacao=p_chave_solicitacao;
  IF FOUND THEN
    IF v_anterior IS DISTINCT FROM v_conteudo THEN
      RAISE EXCEPTION 'Esta tentativa já criou outro conteúdo. Retome o pedido existente.' USING ERRCODE='22023'; END IF;
  ELSE
    -- Outra aba pode ter enviado outra chave com a mesma cotação.
    SELECT id_pdd_fk,conteudo INTO v_pedido,v_anterior FROM privado."Tentativa_Checkout_Cliente"
      WHERE id_clt_fk=v_cliente AND cotacao_id=p_cotacao_id ORDER BY criada_em LIMIT 1;
    IF FOUND THEN
      IF v_anterior IS DISTINCT FROM v_conteudo THEN
        RAISE EXCEPTION 'Esta cotação já criou outro conteúdo. Consulte seus pedidos.' USING ERRCODE='22023'; END IF;
    ELSE
      INSERT INTO public."Endereco"(id_clt_fk,logradouro_end,numero_end,complemento_end,bairro_end,cidade_end,estado_end,cep_end,principal_end)
      VALUES(v_cliente,v_addr->>'logradouro',v_addr->>'numero',v_addr->>'complemento',v_addr->>'bairro',v_addr->>'cidade',v_addr->>'estado',v_addr->>'cep',false)
      RETURNING id_end INTO v_endereco;
      v_criado:=public.criar_pedido_cliente(v_endereco,v_itens,p_chave_solicitacao);
      v_pedido:=(v_criado->>'pedido_id')::integer;
      PERFORM public.aplicar_cotacao_frete_cliente(v_pedido,p_cotacao_id,p_servico_id);
      v_novo:=true;
    END IF;
    INSERT INTO privado."Tentativa_Checkout_Cliente"(id_clt_fk,chave_solicitacao,id_pdd_fk,cotacao_id,conteudo)
      VALUES(v_cliente,p_chave_solicitacao,v_pedido,p_cotacao_id,v_conteudo);
  END IF;
  RETURN public.consultar_checkout_cliente(v_pedido,p_chave_solicitacao)
    ||jsonb_build_object('novo_pedido',v_novo,'chave_solicitacao',p_chave_solicitacao);
END; $fn$;
REVOKE ALL ON FUNCTION public.iniciar_checkout_cliente(uuid,jsonb,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.iniciar_checkout_cliente(uuid,jsonb,jsonb,uuid,integer) TO authenticated;
-- A função acima continua chamando a criação original como proprietária.
REVOKE ALL ON FUNCTION public.criar_pedido_cliente(integer,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.consultar_pagamento_pix_cliente_teste(p_pedido_id integer)
RETURNS TABLE(pagamento_id bigint,pedido_id integer,valor numeric,chave_idempotencia uuid,
  expira_em timestamptz,order_id text,transacao_id text,status_pagamento text,novo_registro boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_cliente integer; v_qtd integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Faça login para consultar o PIX.' USING ERRCODE='42501'; END IF;
  SELECT id_clt INTO v_cliente FROM public."Cliente" WHERE auth_user_id=auth.uid() FOR SHARE;
  PERFORM id_pdd FROM public."Pedido" WHERE id_pdd=p_pedido_id AND id_clt_fk=v_cliente FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado ou sem acesso.' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO v_qtd FROM public."Pagamento" WHERE id_pdd_fk=p_pedido_id;
  IF v_qtd>1 THEN RAISE EXCEPTION 'O pagamento exige análise da loja.'; END IF;
  IF EXISTS(SELECT 1 FROM public."Pagamento" p WHERE p.id_pdd_fk=p_pedido_id
    AND (p.ambiente_pag IS DISTINCT FROM 'teste' OR p.gateway_pag<>'mercadopago' OR p.metodo_pag<>'pix')) THEN
    RAISE EXCEPTION 'Este fluxo consulta somente PIX de teste.'; END IF;
  RETURN QUERY SELECT p.id_pag,p.id_pdd_fk,p.valor_pag,p.chave_idempotencia_pag,p.expira_em,
    p.identificador_gateway_pag,p.identificador_transacao_gateway_pag,p.status_pag,false
    FROM public."Pagamento" p WHERE p.id_pdd_fk=p_pedido_id;
END; $fn$;
REVOKE ALL ON FUNCTION public.consultar_pagamento_pix_cliente_teste(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.consultar_pagamento_pix_cliente_teste(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.registrar_validade_pix_checkout_teste(
 p_pagamento_id bigint,p_order_id text,p_transacao_id text,p_expira_em timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_pedido integer; v_pg public."Pagamento"%ROWTYPE;
BEGIN
 SELECT id_pdd_fk INTO v_pedido FROM public."Pagamento" WHERE id_pag=p_pagamento_id;
 PERFORM id_pdd FROM public."Pedido" WHERE id_pdd=v_pedido FOR UPDATE;
 SELECT * INTO v_pg FROM public."Pagamento" WHERE id_pag=p_pagamento_id FOR UPDATE;
 IF NOT FOUND OR v_pg.ambiente_pag IS DISTINCT FROM 'teste' OR v_pg.gateway_pag<>'mercadopago'
   OR v_pg.metodo_pag<>'pix' OR v_pg.identificador_gateway_pag IS DISTINCT FROM p_order_id
   OR v_pg.identificador_transacao_gateway_pag IS DISTINCT FROM p_transacao_id THEN
   RAISE EXCEPTION 'Pagamento incompatível com o PIX consultado.'; END IF;
 IF p_expira_em IS NULL OR NOT isfinite(p_expira_em) OR v_pg.expira_em IS NULL
   OR p_expira_em>v_pg.expira_em OR p_expira_em<=v_pg.criado_em-interval '1 minute' THEN
   RAISE EXCEPTION 'O vencimento do PIX não está coberto pela reserva.'; END IF;
 IF v_pg.pix_expira_em IS NOT NULL AND v_pg.pix_expira_em IS DISTINCT FROM p_expira_em THEN
   RAISE EXCEPTION 'O vencimento do PIX mudou. A loja precisa revisar o pagamento.'; END IF;
 UPDATE public."Pagamento" SET pix_expira_em=p_expira_em WHERE id_pag=p_pagamento_id AND pix_expira_em IS NULL;
END; $fn$;
REVOKE ALL ON FUNCTION public.registrar_validade_pix_checkout_teste(bigint,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.registrar_validade_pix_checkout_teste(bigint,text,text,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
SELECT
 has_function_privilege('authenticated','public.iniciar_checkout_cliente(uuid,jsonb,jsonb,uuid,integer)','EXECUTE') AS cliente_inicia_checkout,
 has_function_privilege('anon','public.iniciar_checkout_cliente(uuid,jsonb,jsonb,uuid,integer)','EXECUTE') AS visitante_inicia_checkout,
 has_function_privilege('authenticated','public.consultar_checkout_cliente(integer,uuid)','EXECUTE') AS cliente_consulta_checkout,
 has_function_privilege('authenticated','public.registrar_validade_pix_checkout_teste(bigint,text,text,timestamptz)','EXECUTE') AS cliente_altera_validade,
 has_function_privilege('authenticated','public.criar_pedido_cliente(integer,jsonb,uuid)','EXECUTE') AS criacao_antiga_liberada;
