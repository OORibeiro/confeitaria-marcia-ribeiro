-- Somente leitura. Não modifica dados nem exibe registros de clientes/pagamentos.
SELECT jsonb_build_object(
 'colunas', (
   SELECT jsonb_agg(jsonb_build_object('tabela',table_name,'coluna',column_name,'tipo',data_type)
                    ORDER BY table_name,ordinal_position)
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name IN ('Pagamento','Pedido')
 ),
 'funcao_acompanhamento', (
   SELECT jsonb_agg(pg_get_functiondef(p.oid))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='consultar_acompanhamento_pedido'
 )
) AS estrutura_datas;
