-- ============================================================================
-- AJUSTE COMPLEMENTAR NO SUPABASE: SALVAR FRETE NO PEDIDO DO CLIENTE
-- ============================================================================
-- Como a função privado.preparar_pix_pedido exige que a coluna frete_ent
-- esteja preenchida na tabela Pedido_Entrega antes de gerar o PIX, rode este
-- comando no SQL Editor do seu Supabase para permitir que o cliente salve a
-- opção de frete escolhida no checkout:

CREATE OR REPLACE FUNCTION public.salvar_frete_pedido_cliente(
  p_pedido_id integer,
  p_frete numeric,
  p_codigo_servico text,
  p_nome_servico text,
  p_prazo_dias integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_usuario uuid := auth.uid();
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Faça login para salvar o frete.' USING ERRCODE = '42501';
  END IF;

  IF p_frete IS NULL OR p_frete < 0 OR p_prazo_dias IS NULL OR p_prazo_dias < 1 THEN
    RAISE EXCEPTION 'Dados de frete inválidos.';
  END IF;

  PERFORM 1
  FROM public."Pedido" p
  JOIN public."Cliente" c ON c.id_clt = p.id_clt_fk
  WHERE p.id_pdd = p_pedido_id
    AND c.auth_user_id = v_usuario
    AND p.status_pdd = 'pendente'
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado, sem permissão ou não está mais pendente.' USING ERRCODE = '42501';
  END IF;

  UPDATE public."Pedido_Entrega"
  SET frete_ent = round(p_frete, 2),
      codigo_servico_ent = p_codigo_servico,
      nome_servico_ent = p_nome_servico,
      prazo_transporte_dias_ent = p_prazo_dias,
      cotado_em = clock_timestamp()
  WHERE id_pdd_fk = p_pedido_id;

  RETURN jsonb_build_object(
    'sucesso', true,
    'pedido_id', p_pedido_id,
    'frete', round(p_frete, 2)
  );
END;
$function$;
