-- Complemento do pacote 14. Não altera pedidos nem registros de pagamento.
BEGIN;
CREATE OR REPLACE FUNCTION public.consultar_acompanhamento_pedido(p_pedido_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_usuario uuid := auth.uid();
  v_pedido public."Pedido"%ROWTYPE;
  v_entrega public."Pedido_Entrega"%ROWTYPE;
  v_itens jsonb;
  v_pago_em timestamptz;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Faça login para consultar o pedido.' USING ERRCODE = '42501';
  END IF;
  IF p_pedido_id IS NULL OR p_pedido_id <= 0 THEN
    RAISE EXCEPTION 'Pedido inválido.' USING ERRCODE = '22023';
  END IF;
  SELECT p.* INTO v_pedido
  FROM public."Pedido" p
  JOIN public."Cliente" c ON c.id_clt = p.id_clt_fk
  WHERE p.id_pdd = p_pedido_id
    AND (c.auth_user_id = v_usuario OR privado.eh_admin())
  FOR SHARE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado ou sem acesso.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entrega FROM public."Pedido_Entrega" WHERE id_pdd_fk = p_pedido_id;
  -- Exibe a data registrada quando há um único pagamento aprovado.
  -- Nenhuma data é inventada se estiver ausente ou houver aprovações ambíguas.
  SELECT CASE WHEN count(*) = 1 THEN max(pago_em) ELSE NULL END
    INTO v_pago_em
  FROM public."Pagamento"
  WHERE id_pdd_fk = p_pedido_id AND status_pag = 'aprovado';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'item_id', i.id_item,
    'produto_id', i.id_prd_fk,
    'variacao_id', i.id_var_fk,
    'produto', p.nome_prd,
    'variacao', v.nome_var,
    'quantidade', i.quantidade_item,
    'preco_unitario', i.preco_unitario_item,
    'subtotal', i.subtotal_item
  ) ORDER BY i.id_item), '[]'::jsonb)
  INTO v_itens
  FROM public."Item_Pedido" i
  JOIN public."Produto" p ON p.id_prd = i.id_prd_fk
  JOIN public."Produto_Variacao" v ON v.id_prd_fk = i.id_prd_fk AND v.id_var = i.id_var_fk
  WHERE i.id_pdd_fk = p_pedido_id;

  RETURN jsonb_build_object(
    'sucesso', true,
    'pedido_id', v_pedido.id_pdd,
    'numero_pedido', v_pedido.numero_pdd,
    'status_pedido', v_pedido.status_pdd,
    'total', v_pedido.valor_pdd,
    'frete', v_entrega.frete_ent,
    'forma_pagamento', v_pedido.forma_pagamento_pdd,
    'codigo_rastreio', v_pedido.rastreio_pdd,
    'prazo_producao_dias_uteis', v_entrega.prazo_producao_dias_uteis_ent,
    'datas', jsonb_build_object(
      'pedido_criado_em', v_pedido.data_pdd,
      'pagamento_aprovado_em', v_pago_em,
      'producao_iniciada_em', v_entrega.producao_iniciada_em,
      'producao_concluida_em', v_entrega.producao_concluida_em,
      'postado_em', v_entrega.postado_em,
      'entregue_em', v_entrega.entregue_em
    ),
    'itens', v_itens
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.consultar_acompanhamento_pedido(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.consultar_acompanhamento_pedido(integer) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
