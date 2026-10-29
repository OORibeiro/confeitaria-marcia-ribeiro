-- PACOTE 02: cotação autenticada e aplicada sem preço fornecido pelo navegador.
-- Execute inteiro. Não reexecute o antigo salvar_frete_pedido.sql após este pacote.
BEGIN;

CREATE TABLE IF NOT EXISTS privado."Regra_Embalagem_Frete" (
  quantidade_min integer NOT NULL CHECK (quantidade_min BETWEEN 1 AND 10),
  quantidade_max integer NOT NULL CHECK (quantidade_max BETWEEN quantidade_min AND 10),
  id_emb_fk bigint NOT NULL REFERENCES public."Embalagem"(id_emb) ON DELETE RESTRICT,
  peso_protecao_kg numeric(10,3) NOT NULL CHECK (
    peso_protecao_kg >= 0 AND peso_protecao_kg::text NOT IN ('NaN','Infinity','-Infinity')
  ),
  PRIMARY KEY (quantidade_min, quantidade_max, id_emb_fk)
);
ALTER TABLE privado."Regra_Embalagem_Frete" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON privado."Regra_Embalagem_Frete" FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS privado."Cotacao_Frete" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cep_origem text NOT NULL CHECK (cep_origem ~ '^[0-9]{8}$'),
  cep_destino text NOT NULL CHECK (cep_destino ~ '^[0-9]{8}$'),
  contexto jsonb NOT NULL,
  servicos jsonb NOT NULL,
  ambiente text NOT NULL CHECK (ambiente = 'sandbox'),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  expira_em timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '15 minutes'),
  id_pdd_fk integer REFERENCES public."Pedido"(id_pdd) ON DELETE RESTRICT,
  servico_id integer,
  CHECK (jsonb_typeof(contexto) = 'object'),
  CHECK (jsonb_typeof(servicos) = 'array'),
  CHECK (expira_em > criado_em)
);
ALTER TABLE privado."Cotacao_Frete" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON privado."Cotacao_Frete" FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS cotacao_frete_cliente_expiracao
  ON privado."Cotacao_Frete"(auth_user_id, expira_em);
ALTER TABLE public."Pedido_Entrega" ADD COLUMN IF NOT EXISTS cotacao_frete_id uuid
  REFERENCES privado."Cotacao_Frete"(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION privado.preparar_volume_frete(p_itens jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_item jsonb; v_linha record; v_variacao record; v_caixa record;
  v_normalizados jsonb; v_snapshot jsonb := '[]'::jsonb;
  v_quantidade integer; v_peso numeric := 0; v_seguro numeric := 0;
  v_preco numeric; v_agora timestamptz := clock_timestamp();
BEGIN
  IF p_itens IS NULL OR jsonb_typeof(p_itens) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Informe os itens do carrinho.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_itens) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'O pedido deve conter de 1 a 10 potes.' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_itens) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Item inválido.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k(nome)
      WHERE nome NOT IN ('produto_id','variacao_id','quantidade')) THEN
      RAISE EXCEPTION 'Envie apenas produto_id, variacao_id e quantidade.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item->'produto_id') IS DISTINCT FROM 'number'
      OR coalesce(v_item->>'produto_id','') !~ '^[1-9][0-9]{0,9}$'
      OR jsonb_typeof(v_item->'variacao_id') IS DISTINCT FROM 'number'
      OR coalesce(v_item->>'variacao_id','') !~ '^[1-9][0-9]{0,9}$'
      OR jsonb_typeof(v_item->'quantidade') IS DISTINCT FROM 'number'
      OR coalesce(v_item->>'quantidade','') !~ '^[1-9][0-9]?$' THEN
      RAISE EXCEPTION 'Produto, variação e quantidade devem ser inteiros positivos.' USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'produto_id')::numeric > 2147483647
      OR (v_item->>'variacao_id')::numeric > 2147483647
      OR (v_item->>'quantidade')::integer > 10 THEN
      RAISE EXCEPTION 'Item fora dos limites permitidos.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT sum((x->>'quantidade')::integer) INTO v_quantidade FROM jsonb_array_elements(p_itens) x;
  IF v_quantidade NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'O limite por pedido é de 10 potes.' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('produto_id',produto_id,'variacao_id',variacao_id,'quantidade',quantidade)
    ORDER BY produto_id,variacao_id) INTO v_normalizados
  FROM (SELECT (x->>'produto_id')::integer produto_id, (x->>'variacao_id')::integer variacao_id,
    sum((x->>'quantidade')::integer)::integer quantidade FROM jsonb_array_elements(p_itens) x GROUP BY 1,2) t;

  FOR v_linha IN SELECT * FROM jsonb_to_recordset(v_normalizados)
    AS x(produto_id integer, variacao_id integer, quantidade integer)
  LOOP
    SELECT * INTO v_variacao FROM public."Produto_Variacao"
      WHERE id_prd_fk = v_linha.produto_id AND id_var = v_linha.variacao_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Variação não encontrada.' USING ERRCODE = '22023'; END IF;
    IF v_variacao.peso_var IS NULL OR v_variacao.peso_var <= 0
      OR v_variacao.peso_var::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'O peso de um produto precisa ser corrigido pela loja.' USING ERRCODE = '22023';
    END IF;
    SELECT least(v_variacao.preco_var, coalesce(min(round(greatest(0::numeric,
      CASE pro.tipo_desconto_pro
        WHEN 'percentual' THEN v_variacao.preco_var * (1 - pro.valor_desconto_pro / 100)
        WHEN 'valor' THEN v_variacao.preco_var - pro.valor_desconto_pro END), 2)), v_variacao.preco_var))
    INTO v_preco FROM public."Promocao" pro
    WHERE pro.id_prd_fk = v_linha.produto_id AND pro.id_var_fk = v_linha.variacao_id AND pro.ativo_pro
      AND (pro.data_inicio_pro IS NULL OR pro.data_inicio_pro <= v_agora)
      AND (pro.data_fim_pro IS NULL OR pro.data_fim_pro > v_agora);
    IF v_preco IS NULL OR v_preco < 0 OR v_preco::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Preço do produto inválido.' USING ERRCODE = '22023';
    END IF;
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
      'produto_id',v_linha.produto_id,'variacao_id',v_linha.variacao_id,'quantidade',v_linha.quantidade,
      'peso_unitario_kg',v_variacao.peso_var,'preco_unitario',v_preco));
    v_peso := v_peso + v_variacao.peso_var * v_linha.quantidade;
    v_seguro := v_seguro + v_preco * v_linha.quantidade;
  END LOOP;

  -- A capacidade é uma informação física configurada pela loja, não inferida por volume.
  SELECT e.*, r.peso_protecao_kg INTO v_caixa
  FROM privado."Regra_Embalagem_Frete" r JOIN public."Embalagem" e ON e.id_emb = r.id_emb_fk
  WHERE e.ativo_emb AND v_quantidade BETWEEN r.quantidade_min AND r.quantidade_max
    AND e.peso_vazio_kg_emb > 0 AND e.peso_vazio_kg_emb::text NOT IN ('NaN','Infinity','-Infinity')
    AND e.comprimento_cm_emb > 0 AND e.comprimento_cm_emb::text NOT IN ('NaN','Infinity','-Infinity')
    AND e.largura_cm_emb > 0 AND e.largura_cm_emb::text NOT IN ('NaN','Infinity','-Infinity')
    AND e.altura_cm_emb > 0 AND e.altura_cm_emb::text NOT IN ('NaN','Infinity','-Infinity')
  ORDER BY e.comprimento_cm_emb * e.largura_cm_emb * e.altura_cm_emb, e.id_emb,
    r.quantidade_min, r.quantidade_max LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A entrega para esta quantidade está indisponível. Entre em contato com a loja.' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('itens',v_snapshot,'quantidadePotes',v_quantidade,
    'embalagem',jsonb_build_object('id',v_caixa.id_emb,'peso_vazio_kg',v_caixa.peso_vazio_kg_emb,
      'peso_protecao_kg',v_caixa.peso_protecao_kg),
    'volume',jsonb_build_object('width',v_caixa.largura_cm_emb,'height',v_caixa.altura_cm_emb,
      'length',v_caixa.comprimento_cm_emb,
      'weight',round(v_peso + v_caixa.peso_vazio_kg_emb + v_caixa.peso_protecao_kg,3),
      'insurance',round(v_seguro,2)));
END; $fn$;
REVOKE ALL ON FUNCTION privado.preparar_volume_frete(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preparar_cotacao_frete_cliente(p_itens jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public."Cliente" WHERE auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Entre na sua conta e conclua seu cadastro para calcular o frete.' USING ERRCODE = '42501';
  END IF;
  RETURN privado.preparar_volume_frete(p_itens);
END; $fn$;
REVOKE ALL ON FUNCTION public.preparar_cotacao_frete_cliente(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preparar_cotacao_frete_cliente(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.registrar_cotacao_frete_servidor(
  p_usuario uuid, p_contexto jsonb, p_cep_origem text, p_cep_destino text, p_servicos jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_itens jsonb; v_contexto jsonb; v_servico jsonb; v_cotacao privado."Cotacao_Frete"%ROWTYPE;
BEGIN
  IF p_usuario IS NULL OR NOT EXISTS (SELECT 1 FROM public."Cliente" WHERE auth_user_id = p_usuario) THEN
    RAISE EXCEPTION 'Cliente inválido.' USING ERRCODE = '22023';
  END IF;
  IF p_cep_origem IS NULL OR p_cep_origem !~ '^[0-9]{8}$'
    OR p_cep_destino IS NULL OR p_cep_destino !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'CEP inválido.' USING ERRCODE = '22023';
  END IF;
  IF p_contexto IS NULL OR jsonb_typeof(p_contexto->'itens') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Contexto da cotação inválido.' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(x - 'peso_unitario_kg' - 'preco_unitario') INTO v_itens
    FROM jsonb_array_elements(p_contexto->'itens') x;
  v_contexto := privado.preparar_volume_frete(v_itens);
  IF v_contexto IS DISTINCT FROM p_contexto THEN
    RAISE EXCEPTION 'O carrinho ou a embalagem mudou durante a cotação. Calcule novamente.' USING ERRCODE = '22023';
  END IF;
  IF p_servicos IS NULL OR jsonb_typeof(p_servicos) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nenhum serviço de entrega válido.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_servicos) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Nenhum serviço de entrega válido.' USING ERRCODE = '22023';
  END IF;
  FOR v_servico IN SELECT value FROM jsonb_array_elements(p_servicos) LOOP
    IF jsonb_typeof(v_servico) IS DISTINCT FROM 'object'
      OR coalesce(v_servico->>'id','') !~ '^[1-9][0-9]{0,9}$'
      OR coalesce(v_servico->>'price','') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$'
      OR coalesce(v_servico->>'delivery_time','') !~ '^[0-9]{1,3}$'
      OR nullif(btrim(v_servico->>'name'),'') IS NULL
      OR length(v_servico->>'name') > 120
      OR nullif(btrim(v_servico->'company'->>'name'),'') IS NULL
      OR length(v_servico->'company'->>'name') > 120 THEN
      RAISE EXCEPTION 'Serviço de entrega inválido.' USING ERRCODE = '22023';
    END IF;
    IF (v_servico->>'id')::numeric > 2147483647
      OR (v_servico->>'price')::numeric <= 0
      OR (v_servico->>'price')::numeric > 1000000
      OR (v_servico->>'delivery_time')::integer > 365 THEN
      RAISE EXCEPTION 'Serviço de entrega fora dos limites.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_servicos) x) <> jsonb_array_length(p_servicos) THEN
    RAISE EXCEPTION 'Serviços duplicados na cotação.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO privado."Cotacao_Frete"(auth_user_id,cep_origem,cep_destino,contexto,servicos,ambiente)
    VALUES (p_usuario,p_cep_origem,p_cep_destino,v_contexto,p_servicos,'sandbox') RETURNING * INTO v_cotacao;
  RETURN jsonb_build_object('sucesso',true,'cotacao_id',v_cotacao.id,'expira_em',v_cotacao.expira_em,
    'ambiente',v_cotacao.ambiente,'quantidadePotes',v_contexto->'quantidadePotes',
    'volumeCotado',v_contexto->'volume','cotacoes',v_cotacao.servicos);
END; $fn$;
REVOKE ALL ON FUNCTION public.registrar_cotacao_frete_servidor(uuid,jsonb,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registrar_cotacao_frete_servidor(uuid,jsonb,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION privado.exigir_frete_validado(p_pedido_id integer, p_exigir_vigente boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_entrega public."Pedido_Entrega"%ROWTYPE; v_cotacao privado."Cotacao_Frete"%ROWTYPE;
  v_usuario uuid; v_itens jsonb; v_servico jsonb;
BEGIN
  SELECT c.auth_user_id INTO v_usuario FROM public."Pedido" p
    JOIN public."Cliente" c ON c.id_clt = p.id_clt_fk WHERE p.id_pdd = p_pedido_id;
  SELECT * INTO v_entrega FROM public."Pedido_Entrega" WHERE id_pdd_fk = p_pedido_id;
  IF NOT FOUND OR v_entrega.cotacao_frete_id IS NULL THEN
    RAISE EXCEPTION 'Calcule e aplique uma cotação de frete válida antes de gerar o PIX.';
  END IF;
  SELECT * INTO v_cotacao FROM privado."Cotacao_Frete" WHERE id = v_entrega.cotacao_frete_id;
  IF NOT FOUND OR v_cotacao.auth_user_id IS DISTINCT FROM v_usuario
    OR v_cotacao.id_pdd_fk IS DISTINCT FROM p_pedido_id
    OR v_cotacao.cep_destino IS DISTINCT FROM v_entrega.cep_ent THEN
    RAISE EXCEPTION 'A cotação de frete não corresponde ao pedido.';
  END IF;
  IF p_exigir_vigente AND v_cotacao.expira_em <= clock_timestamp() THEN
    RAISE EXCEPTION 'A cotação de frete expirou. Calcule novamente.';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('produto_id',id_prd_fk,'variacao_id',id_var_fk,
    'quantidade',quantidade_item,'peso_unitario_kg',peso_unitario_kg_item,'preco_unitario',preco_unitario_item)
    ORDER BY id_prd_fk,id_var_fk) INTO v_itens FROM public."Item_Pedido" WHERE id_pdd_fk = p_pedido_id;
  IF v_itens IS DISTINCT FROM v_cotacao.contexto->'itens' THEN
    RAISE EXCEPTION 'Os itens ou preços do pedido mudaram. Calcule o frete novamente.';
  END IF;
  SELECT x INTO v_servico FROM jsonb_array_elements(v_cotacao.servicos) x
    WHERE (x->>'id')::integer = v_cotacao.servico_id;
  IF v_servico IS NULL OR v_entrega.frete_ent IS DISTINCT FROM (v_servico->>'price')::numeric
    OR v_entrega.codigo_servico_ent IS DISTINCT FROM v_cotacao.servico_id::text
    OR v_entrega.prazo_transporte_dias_ent IS DISTINCT FROM (v_servico->>'delivery_time')::integer
    OR v_entrega.id_emb_fk IS DISTINCT FROM (v_cotacao.contexto->'embalagem'->>'id')::bigint
    OR v_entrega.peso_total_kg_ent IS DISTINCT FROM (v_cotacao.contexto->'volume'->>'weight')::numeric
    OR v_entrega.peso_embalagem_kg_ent IS DISTINCT FROM (v_cotacao.contexto->'embalagem'->>'peso_vazio_kg')::numeric
    OR v_entrega.peso_protecao_kg_ent IS DISTINCT FROM (v_cotacao.contexto->'embalagem'->>'peso_protecao_kg')::numeric
    OR v_entrega.comprimento_cm_ent IS DISTINCT FROM (v_cotacao.contexto->'volume'->>'length')::numeric
    OR v_entrega.largura_cm_ent IS DISTINCT FROM (v_cotacao.contexto->'volume'->>'width')::numeric
    OR v_entrega.altura_cm_ent IS DISTINCT FROM (v_cotacao.contexto->'volume'->>'height')::numeric THEN
    RAISE EXCEPTION 'Os dados de entrega não correspondem à cotação validada.';
  END IF;
END; $fn$;
REVOKE ALL ON FUNCTION privado.exigir_frete_validado(integer,boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.aplicar_cotacao_frete_cliente(
  p_pedido_id integer, p_cotacao_id uuid, p_servico_id integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_entrega public."Pedido_Entrega"%ROWTYPE; v_cotacao privado."Cotacao_Frete"%ROWTYPE;
  v_servico jsonb; v_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Faça login para continuar.' USING ERRCODE = '42501'; END IF;
  SELECT p.status_pdd INTO v_status FROM public."Pedido" p JOIN public."Cliente" c ON c.id_clt = p.id_clt_fk
    WHERE p.id_pdd = p_pedido_id AND c.auth_user_id = auth.uid() FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado ou sem acesso.' USING ERRCODE = '42501'; END IF;
  IF v_status <> 'pendente' THEN RAISE EXCEPTION 'O pedido não pode mais alterar o frete.'; END IF;
  SELECT * INTO v_entrega FROM public."Pedido_Entrega" WHERE id_pdd_fk = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido sem endereço de entrega.'; END IF;
  SELECT * INTO v_cotacao FROM privado."Cotacao_Frete"
    WHERE id = p_cotacao_id AND auth_user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cotação não encontrada ou sem acesso.' USING ERRCODE = '42501'; END IF;
  IF v_cotacao.id_pdd_fk IS NOT NULL AND v_cotacao.id_pdd_fk <> p_pedido_id THEN
    RAISE EXCEPTION 'Esta cotação já foi utilizada em outro pedido.';
  END IF;
  IF v_entrega.cotacao_frete_id = p_cotacao_id AND v_cotacao.servico_id = p_servico_id
    AND v_cotacao.id_pdd_fk = p_pedido_id THEN
    PERFORM privado.exigir_frete_validado(p_pedido_id, false);
  ELSE
    IF EXISTS (SELECT 1 FROM public."Pagamento" WHERE id_pdd_fk = p_pedido_id)
      OR EXISTS (SELECT 1 FROM public."Venda" WHERE id_pdd_fk = p_pedido_id) THEN
      RAISE EXCEPTION 'O pagamento já foi preparado. Retome o mesmo pedido sem alterar o frete.';
    END IF;
    IF v_cotacao.expira_em <= clock_timestamp() THEN RAISE EXCEPTION 'A cotação expirou. Calcule novamente.'; END IF;
    SELECT x INTO v_servico FROM jsonb_array_elements(v_cotacao.servicos) x WHERE (x->>'id')::integer = p_servico_id;
    IF v_servico IS NULL THEN RAISE EXCEPTION 'Serviço não disponível nesta cotação.'; END IF;
    UPDATE privado."Cotacao_Frete" SET id_pdd_fk = p_pedido_id, servico_id = p_servico_id WHERE id = p_cotacao_id;
    UPDATE public."Pedido_Entrega" SET cotacao_frete_id = p_cotacao_id,
      frete_ent = (v_servico->>'price')::numeric,
      codigo_servico_ent = p_servico_id::text,
      nome_servico_ent = (v_servico->'company'->>'name') || ' - ' || (v_servico->>'name'),
      prazo_transporte_dias_ent = (v_servico->>'delivery_time')::integer,
      cotado_em = v_cotacao.criado_em,
      id_emb_fk = (v_cotacao.contexto->'embalagem'->>'id')::bigint,
      peso_embalagem_kg_ent = (v_cotacao.contexto->'embalagem'->>'peso_vazio_kg')::numeric,
      peso_protecao_kg_ent = (v_cotacao.contexto->'embalagem'->>'peso_protecao_kg')::numeric,
      peso_total_kg_ent = (v_cotacao.contexto->'volume'->>'weight')::numeric,
      comprimento_cm_ent = (v_cotacao.contexto->'volume'->>'length')::numeric,
      largura_cm_ent = (v_cotacao.contexto->'volume'->>'width')::numeric,
      altura_cm_ent = (v_cotacao.contexto->'volume'->>'height')::numeric
    WHERE id_pdd_fk = p_pedido_id;
    PERFORM privado.exigir_frete_validado(p_pedido_id, true);
  END IF;
  SELECT * INTO v_entrega FROM public."Pedido_Entrega" WHERE id_pdd_fk = p_pedido_id;
  RETURN jsonb_build_object('sucesso',true,'pedido_id',p_pedido_id,'frete',v_entrega.frete_ent,
    'total',(SELECT sum(subtotal_item) FROM public."Item_Pedido" WHERE id_pdd_fk = p_pedido_id) + v_entrega.frete_ent);
END; $fn$;
REVOKE ALL ON FUNCTION public.aplicar_cotacao_frete_cliente(integer,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.aplicar_cotacao_frete_cliente(integer,uuid,integer) TO authenticated;

-- A assinatura antiga não pode aceitar preços arbitrários, nem por concessão futura.
CREATE OR REPLACE FUNCTION public.salvar_frete_pedido_cliente(
  p_pedido_id integer, p_frete numeric, p_codigo_servico text, p_nome_servico text, p_prazo_dias integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'Atualize o site e utilize uma cotação validada pelo servidor.' USING ERRCODE = '42501';
END; $fn$;
REVOKE ALL ON FUNCTION public.salvar_frete_pedido_cliente(integer,numeric,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- As duas funções de preparação do PIX recebem abaixo a exigência de frete validado.
CREATE OR REPLACE FUNCTION privado.preparar_pix_pedido(p_pedido_id integer, p_ambiente text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_status TEXT;
  v_subtotal NUMERIC;
  v_frete NUMERIC;
  v_total NUMERIC;
  v_expira_em TIMESTAMPTZ;
  v_pagamento_id BIGINT;
BEGIN
  IF p_ambiente IS NULL
     OR p_ambiente NOT IN ('teste', 'producao')
  THEN
    RAISE EXCEPTION 'Informe o ambiente teste ou producao.';
  END IF;

  SELECT status_pdd
  INTO v_status
  FROM public."Pedido"
  WHERE id_pdd = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;

  IF v_status IS DISTINCT FROM 'pendente' THEN
    RAISE EXCEPTION 'O pedido precisa estar pendente.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Pagamento"
    WHERE id_pdd_fk = p_pedido_id
  ) OR EXISTS (
    SELECT 1
    FROM public."Venda"
    WHERE id_pdd_fk = p_pedido_id
  ) THEN
    RAISE EXCEPTION
      'O pedido já possui venda ou pagamento. Consulte o registro existente.';
  END IF;

  PERFORM privado.exigir_frete_validado(p_pedido_id, true);

  -- Protege os itens durante a preparação.
  PERFORM id_item
  FROM public."Item_Pedido"
  WHERE id_pdd_fk = p_pedido_id
  ORDER BY id_item
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido sem itens.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Item_Pedido"
    WHERE id_pdd_fk = p_pedido_id
      AND (
        preco_unitario_item::TEXT IN ('NaN', 'Infinity', '-Infinity')
        OR subtotal_item::TEXT IN ('NaN', 'Infinity', '-Infinity')
        OR preco_unitario_item <> round(preco_unitario_item, 2)
        OR subtotal_item IS DISTINCT FROM
           round(preco_unitario_item * quantidade_item, 2)
      )
  ) THEN
    RAISE EXCEPTION 'Os valores dos itens estão inconsistentes.';
  END IF;

  SELECT frete_ent
  INTO v_frete
  FROM public."Pedido_Entrega"
  WHERE id_pdd_fk = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND OR v_frete IS NULL THEN
    RAISE EXCEPTION 'Salve o endereço e o frete antes de preparar o PIX.';
  END IF;

  IF v_frete::TEXT IN ('NaN', 'Infinity', '-Infinity')
     OR v_frete < 0
     OR v_frete <> round(v_frete, 2)
  THEN
    RAISE EXCEPTION 'Frete inválido.';
  END IF;

  -- Toda reserva precisa estar ativa e dentro do prazo.
  IF NOT EXISTS (
    SELECT 1
    FROM public."Reserva_Estoque"
    WHERE id_pdd_fk = p_pedido_id
  ) OR EXISTS (
    SELECT 1
    FROM public."Reserva_Estoque"
    WHERE id_pdd_fk = p_pedido_id
      AND (
        status_res <> 'reservada'
        OR expira_em <= clock_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'O pedido precisa ter uma reserva ativa e não vencida.';
  END IF;

  -- As quantidades reservadas devem corresponder aos itens.
  IF EXISTS (
    WITH itens AS (
      SELECT id_prd_fk, id_var_fk, sum(quantidade_item) AS quantidade
      FROM public."Item_Pedido"
      WHERE id_pdd_fk = p_pedido_id
      GROUP BY id_prd_fk, id_var_fk
    ),
    reservas AS (
      SELECT id_prd_fk, id_var_fk, quantidade_res AS quantidade
      FROM public."Reserva_Estoque"
      WHERE id_pdd_fk = p_pedido_id
    )
    SELECT 1
    FROM itens i
    FULL JOIN reservas r USING (id_prd_fk, id_var_fk)
    WHERE i.quantidade IS DISTINCT FROM r.quantidade
  ) THEN
    RAISE EXCEPTION 'As reservas não correspondem aos itens do pedido.';
  END IF;

  SELECT min(expira_em)
  INTO v_expira_em
  FROM public."Reserva_Estoque"
  WHERE id_pdd_fk = p_pedido_id;

  SELECT sum(subtotal_item)
  INTO v_subtotal
  FROM public."Item_Pedido"
  WHERE id_pdd_fk = p_pedido_id;

  v_total := v_subtotal + v_frete;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'O valor do PIX precisa ser maior que zero.';
  END IF;

  INSERT INTO public."Venda" (
    id_pdd_fk,
    subtotal_vnd,
    desconto_vnd,
    frete_vnd,
    total_vnd,
    status_vnd,
    forma_pagamento_vnd
  )
  VALUES (
    p_pedido_id,
    v_subtotal,
    0,
    v_frete,
    v_total,
    'pendente',
    'pix'
  );

  UPDATE public."Pedido"
  SET valor_pdd = v_total,
      forma_pagamento_pdd = 'pix'
  WHERE id_pdd = p_pedido_id;

  INSERT INTO public."Pagamento" (
    id_pdd_fk,
    gateway_pag,
    ambiente_pag,
    valor_pag,
    metodo_pag,
    status_pag,
    criado_em,
    expira_em
  )
  VALUES (
    p_pedido_id,
    'mercadopago',
    p_ambiente,
    v_total,
    'pix',
    'pendente',
    clock_timestamp(),
    v_expira_em
  )
  RETURNING id_pag INTO v_pagamento_id;

  RETURN v_pagamento_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.preparar_pix_cliente_teste(p_pedido_id integer)
 RETURNS TABLE(pagamento_id bigint, pedido_id integer, valor numeric, chave_idempotencia uuid, expira_em timestamp with time zone, order_id text, transacao_id text, status_pagamento text, novo_registro boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_usuario UUID := auth.uid();
  v_status_pedido TEXT;
  v_quantidade BIGINT;
  v_pagamento_id BIGINT;
  v_pagamento public."Pagamento"%ROWTYPE;
  v_novo BOOLEAN := false;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Faça login para preparar o pagamento.'
      USING ERRCODE = '42501';
  END IF;

  IF p_pedido_id IS NULL OR p_pedido_id <= 0 THEN
    RAISE EXCEPTION 'Pedido inválido.'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.status_pdd
  INTO v_status_pedido
  FROM public."Pedido" AS p
  JOIN public."Cliente" AS c
    ON c.id_clt = p.id_clt_fk
  WHERE p.id_pdd = p_pedido_id
    AND c.auth_user_id = v_usuario
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado ou sem acesso.'
      USING ERRCODE = '42501';
  END IF;

  IF v_status_pedido = 'pendente' THEN
    PERFORM privado.exigir_frete_validado(p_pedido_id, false);
  END IF;

  SELECT COUNT(*)
  INTO v_quantidade
  FROM public."Pagamento" AS pg
  WHERE pg.id_pdd_fk = p_pedido_id;

  IF v_quantidade = 0 THEN
    v_pagamento_id := privado.preparar_pix_pedido(
      p_pedido_id,
      'teste'
    );

    SELECT pg.*
    INTO STRICT v_pagamento
    FROM public."Pagamento" AS pg
    WHERE pg.id_pag = v_pagamento_id;

    v_novo := true;
  ELSE
    IF v_quantidade <> 1 THEN
      RAISE EXCEPTION 'O pedido exige análise dos pagamentos existentes.';
    END IF;

    SELECT pg.*
    INTO STRICT v_pagamento
    FROM public."Pagamento" AS pg
    WHERE pg.id_pdd_fk = p_pedido_id
    FOR UPDATE;

    IF v_pagamento.gateway_pag <> 'mercadopago'
      OR v_pagamento.ambiente_pag IS DISTINCT FROM 'teste'
      OR v_pagamento.metodo_pag <> 'pix'
      OR v_pagamento.status_pag NOT IN ('pendente', 'aprovado')
    THEN
      RAISE EXCEPTION 'O pagamento existente não pode ser retomado neste fluxo.';
    END IF;

    IF v_pagamento.status_pag = 'pendente' THEN
      IF v_status_pedido <> 'pendente'
        OR v_pagamento.expira_em IS NULL
        OR v_pagamento.expira_em <= clock_timestamp()
        OR NOT EXISTS (
          SELECT 1
          FROM public."Reserva_Estoque" AS r
          WHERE r.id_pdd_fk = p_pedido_id
        )
        OR EXISTS (
          SELECT 1
          FROM public."Reserva_Estoque" AS r
          WHERE r.id_pdd_fk = p_pedido_id
            AND (
              r.status_res <> 'reservada'
              OR r.expira_em <= clock_timestamp()
            )
        )
      THEN
        RAISE EXCEPTION 'O pagamento pendente não possui reserva válida.';
      END IF;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    v_pagamento.id_pag,
    v_pagamento.id_pdd_fk,
    v_pagamento.valor_pag,
    v_pagamento.chave_idempotencia_pag,
    v_pagamento.expira_em,
    v_pagamento.identificador_gateway_pag,
    v_pagamento.identificador_transacao_gateway_pag,
    v_pagamento.status_pag,
    v_novo;
END;
$function$
;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT
  has_function_privilege('authenticated','public.aplicar_cotacao_frete_cliente(integer,uuid,integer)','EXECUTE') AS cliente_aplica_cotacao,
  has_function_privilege('anon','public.aplicar_cotacao_frete_cliente(integer,uuid,integer)','EXECUTE') AS visitante_aplica_cotacao,
  has_function_privilege('authenticated','public.registrar_cotacao_frete_servidor(uuid,jsonb,text,text,jsonb)','EXECUTE') AS cliente_inventa_cotacao,
  has_function_privilege('authenticated','public.salvar_frete_pedido_cliente(integer,numeric,text,text,integer)','EXECUTE') AS cliente_envia_preco,
  (SELECT count(*) FROM privado."Regra_Embalagem_Frete") AS regras_de_embalagem;
