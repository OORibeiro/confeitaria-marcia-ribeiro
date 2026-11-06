-- Executar uma vez no SQL Editor antes de atualizar o painel.
BEGIN;
CREATE OR REPLACE FUNCTION public.mr_detalhes_pedido_admin(p_pedido_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dados jsonb;
  v_endereco jsonb;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(privado.eh_admin(), false) THEN
    RAISE EXCEPTION 'Acesso exclusivo de administradores.' USING ERRCODE = '42501';
  END IF;
  IF p_pedido_id IS NULL OR p_pedido_id <= 0 THEN
    RAISE EXCEPTION 'Pedido inválido.' USING ERRCODE = '22023';
  END IF;
  v_dados := public.consultar_acompanhamento_pedido(p_pedido_id);
  -- Usa o endereço vinculado ao pedido, nunca o endereço principal atual do cliente.
  SELECT jsonb_build_object(
    'logradouro', e.logradouro_end, 'numero', e.numero_end,
    'complemento', e.complemento_end, 'bairro', e.bairro_end,
    'cidade', e.cidade_end, 'estado', e.estado_end, 'cep', e.cep_end
  ) INTO v_endereco
  FROM public."Pedido" p
  JOIN public."Endereco" e ON e.id_end = p.id_end_fk
  WHERE p.id_pdd = p_pedido_id;
  SELECT pg.status_pag INTO v_status FROM public."Pagamento" pg
  WHERE pg.id_pdd_fk = p_pedido_id ORDER BY pg.criado_em DESC, pg.id_pag DESC LIMIT 1;
  RETURN v_dados || jsonb_build_object('endereco', v_endereco, 'status_pagamento', v_status);
END;
$$;
REVOKE ALL ON FUNCTION public.mr_detalhes_pedido_admin(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mr_detalhes_pedido_admin(integer) TO authenticated;
COMMIT;
