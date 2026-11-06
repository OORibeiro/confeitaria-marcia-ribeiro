-- Execute uma vez no SQL Editor, antes de instalar o novo painel.
-- Não altera preços, estoque, pedidos ou reservas existentes.
BEGIN;
ALTER TABLE public."Produto" ADD COLUMN IF NOT EXISTS ativo_prd boolean NOT NULL DEFAULT true;
ALTER TABLE public."Produto_Variacao" ADD COLUMN IF NOT EXISTS ativo_var boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS privado.mr_operacao_produto (
  usuario uuid NOT NULL, chave uuid NOT NULL, entrada jsonb NOT NULL,
  resultado jsonb, criada_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario, chave)
);
REVOKE ALL ON privado.mr_operacao_produto FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION privado.mr_produto_snapshot(p_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
 SELECT to_jsonb(p) || jsonb_build_object('variacoes', coalesce((
   SELECT jsonb_agg(to_jsonb(v) || jsonb_build_object(
     'quantidade_est', e.quantidade_est, 'reservada_est', e.reservada_est,
     'disponivel_est', e.disponivel_est) ORDER BY v.id_var)
   FROM public."Produto_Variacao" v LEFT JOIN public."Estoque" e
     ON e.id_prd_fk=v.id_prd_fk AND e.id_var_fk=v.id_var
   WHERE v.id_prd_fk=p.id_prd), '[]'::jsonb))
 FROM public."Produto" p WHERE p.id_prd=p_id;
$fn$;
REVOKE ALL ON FUNCTION privado.mr_produto_snapshot(integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mr_listar_produtos_admin()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_resultado jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(privado.eh_admin(),false) THEN
   RAISE EXCEPTION 'Acesso exclusivo do administrador.' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(s.dados || jsonb_build_object('versao',md5(s.dados::text)) ORDER BY s.id_prd DESC),'[]'::jsonb)
 INTO v_resultado FROM (SELECT p.id_prd, privado.mr_produto_snapshot(p.id_prd) dados FROM public."Produto" p) s;
 RETURN v_resultado;
END; $fn$;

CREATE OR REPLACE FUNCTION public.mr_salvar_produto_admin(p_dados jsonb, p_chave uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
 v_pid integer; v_vid integer; v_row jsonb; v_atual jsonb; v_op record;
 v_nome text; v_preco numeric; v_peso numeric; v_validade integer; v_prazo integer;
 v_total integer; v_reservado integer; v_ids integer[] := '{}'; v_id integer;
 v_resultado jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(privado.eh_admin(),false) THEN
   RAISE EXCEPTION 'Acesso exclusivo do administrador.' USING ERRCODE='42501';
 END IF;
 IF p_chave IS NULL OR jsonb_typeof(p_dados) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'Solicitação inválida.' USING ERRCODE='22023';
 END IF;
 INSERT INTO privado.mr_operacao_produto(usuario,chave,entrada)
 VALUES(auth.uid(),p_chave,p_dados) ON CONFLICT DO NOTHING;
 SELECT * INTO v_op FROM privado.mr_operacao_produto
 WHERE usuario=auth.uid() AND chave=p_chave FOR UPDATE;
 IF v_op.entrada IS DISTINCT FROM p_dados THEN
   RAISE EXCEPTION 'A solicitação já foi utilizada com outros dados.';
 END IF;
 IF v_op.resultado IS NOT NULL THEN RETURN v_op.resultado; END IF;
 v_pid := (p_dados->>'id_prd')::integer;
 v_nome := btrim(p_dados->>'nome_prd');
 IF v_nome IS NULL OR length(v_nome) NOT BETWEEN 1 AND 150
   OR length(coalesce(p_dados->>'descricao_prd',''))>10000
   OR length(coalesce(p_dados->>'imagem_prd',''))>2048
   OR (nullif(p_dados->>'imagem_prd','') IS NOT NULL AND (p_dados->>'imagem_prd') !~ '^https://[^[:space:]]+$')
   OR jsonb_typeof(p_dados->'ativo_prd') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_dados->'variacoes') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Confira nome, descrição, imagem HTTPS e variações.' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_dados->'variacoes') NOT BETWEEN 1 AND 50 THEN
   RAISE EXCEPTION 'Cadastre entre 1 e 50 variações por produto.';
 END IF;
 IF v_pid IS NOT NULL THEN
   PERFORM id_prd FROM public."Produto" WHERE id_prd=v_pid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Produto não encontrado. Atualize a lista.'; END IF;
   PERFORM id_var FROM public."Produto_Variacao" WHERE id_prd_fk=v_pid ORDER BY id_var FOR UPDATE;
   PERFORM id_est FROM public."Estoque" WHERE id_prd_fk=v_pid ORDER BY id_var_fk FOR UPDATE;
   v_atual := privado.mr_produto_snapshot(v_pid);
   IF p_dados->>'versao' IS DISTINCT FROM md5(v_atual::text) THEN
     RAISE EXCEPTION 'O produto ou estoque mudou desde a abertura. Reabra o produto para editar os dados atuais.' USING ERRCODE='40001';
   END IF;
   -- Não remover silenciosamente uma variação omitida pelo navegador.
   FOR v_id IN SELECT id_var FROM public."Produto_Variacao" WHERE id_prd_fk=v_pid LOOP
     IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_dados->'variacoes') x WHERE (x->>'id_var')::integer=v_id) THEN
       RAISE EXCEPTION 'Uma variação existente foi omitida. Desative-a em vez de removê-la.';
     END IF;
   END LOOP;
 ELSE
   INSERT INTO public."Produto"(nome_prd,descricao_prd,imagem_prd,ativo_prd)
   VALUES(v_nome,nullif(p_dados->>'descricao_prd',''),nullif(p_dados->>'imagem_prd',''),(p_dados->>'ativo_prd')::boolean)
   RETURNING id_prd INTO v_pid;
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_dados->'variacoes') x
   GROUP BY lower(btrim(x->>'nome_var')) HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Use nomes diferentes para as variações do produto.';
 END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_dados->'variacoes') LOOP
   v_vid := (v_row->>'id_var')::integer;
   v_preco := (v_row->>'preco_var')::numeric;
   v_peso := (v_row->>'peso_var')::numeric;
   -- Converte o texto diretamente para integer: rejeita frações.
   v_validade := (v_row->>'validade_dias_var')::integer;
   v_prazo := (v_row->>'prazo_producao_dias_uteis_var')::integer;
   v_total := (v_row->>'quantidade_est')::integer;
   IF jsonb_typeof(v_row) IS DISTINCT FROM 'object'
     OR btrim(v_row->>'nome_var') IS NULL OR length(btrim(v_row->>'nome_var')) NOT BETWEEN 1 AND 100
     OR v_preco IS NULL OR v_preco::text IN ('NaN','Infinity','-Infinity') OR v_preco<=0 OR v_preco>999999 OR v_preco<>round(v_preco,2)
     OR v_peso IS NULL OR v_peso::text IN ('NaN','Infinity','-Infinity') OR v_peso<=0 OR v_peso>30 OR v_peso<>round(v_peso,3)
     OR v_validade IS NULL OR v_validade NOT BETWEEN 1 AND 3650
     OR v_prazo IS NULL OR v_prazo NOT BETWEEN 0 AND 365
     OR v_total IS NULL OR v_total NOT BETWEEN 0 AND 1000000
     OR jsonb_typeof(v_row->'ativo_var') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_row->'tem_lactose_var') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_row->'tem_gluten_var') IS DISTINCT FROM 'boolean' THEN
     RAISE EXCEPTION 'Preencha cada variação com nome, preço positivo, peso, validade, prazo e estoque válidos.' USING ERRCODE='22023';
   END IF;
   IF v_vid IS NOT NULL THEN
     IF v_vid=ANY(v_ids) THEN RAISE EXCEPTION 'Variação repetida.'; END IF;
     v_ids := array_append(v_ids,v_vid);
     IF NOT EXISTS (SELECT 1 FROM public."Produto_Variacao" WHERE id_prd_fk=v_pid AND id_var=v_vid) THEN
       RAISE EXCEPTION 'Esta variação não pertence ao produto.';
     END IF;
     UPDATE public."Produto_Variacao" SET nome_var=btrim(v_row->>'nome_var'),preco_var=v_preco,peso_var=v_peso,
       validade_dias_var=v_validade,prazo_producao_dias_uteis_var=v_prazo,
       tem_lactose_var=(v_row->>'tem_lactose_var')::boolean,tem_gluten_var=(v_row->>'tem_gluten_var')::boolean,
       ativo_var=(v_row->>'ativo_var')::boolean WHERE id_prd_fk=v_pid AND id_var=v_vid;
   ELSE
     INSERT INTO public."Produto_Variacao"(id_prd_fk,nome_var,preco_var,peso_var,validade_dias_var,
       prazo_producao_dias_uteis_var,tem_lactose_var,tem_gluten_var,ativo_var)
     VALUES(v_pid,btrim(v_row->>'nome_var'),v_preco,v_peso,v_validade,v_prazo,
       (v_row->>'tem_lactose_var')::boolean,(v_row->>'tem_gluten_var')::boolean,(v_row->>'ativo_var')::boolean)
     RETURNING id_var INTO v_vid;
   END IF;
   -- O gatilho existente cria o estoque. Nunca escrever em reservada_est ou disponivel_est.
   SELECT reservada_est INTO v_reservado FROM public."Estoque"
     WHERE id_prd_fk=v_pid AND id_var_fk=v_vid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Estoque da variação ausente. Contate o suporte.'; END IF;
   IF v_total<v_reservado THEN
     RAISE EXCEPTION 'O estoque físico não pode ser menor que as % unidades reservadas.',v_reservado;
   END IF;
   UPDATE public."Estoque" SET quantidade_est=v_total WHERE id_prd_fk=v_pid AND id_var_fk=v_vid;
 END LOOP;
 UPDATE public."Produto" SET nome_prd=v_nome,descricao_prd=nullif(p_dados->>'descricao_prd',''),
   imagem_prd=nullif(p_dados->>'imagem_prd',''),ativo_prd=(p_dados->>'ativo_prd')::boolean WHERE id_prd=v_pid;
 v_resultado := jsonb_build_object('sucesso',true,'produto_id',v_pid);
 UPDATE privado.mr_operacao_produto SET resultado=v_resultado WHERE usuario=auth.uid() AND chave=p_chave;
 RETURN v_resultado;
END; $fn$;

CREATE OR REPLACE FUNCTION public.mr_excluir_produto_admin(p_id integer,p_versao text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE r record; v_join text; v_existe boolean; v_filtro text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(privado.eh_admin(),false) THEN
   RAISE EXCEPTION 'Acesso exclusivo do administrador.' USING ERRCODE='42501';
 END IF;
 PERFORM id_prd FROM public."Produto" WHERE id_prd=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('sucesso',true,'produto_id',p_id); END IF;
 PERFORM id_var FROM public."Produto_Variacao" WHERE id_prd_fk=p_id ORDER BY id_var FOR UPDATE;
 PERFORM id_est FROM public."Estoque" WHERE id_prd_fk=p_id ORDER BY id_var_fk FOR UPDATE;
 IF p_versao IS DISTINCT FROM md5(privado.mr_produto_snapshot(p_id)::text) THEN
   RAISE EXCEPTION 'O produto ou estoque mudou. Atualize a lista antes de excluir.' USING ERRCODE='40001';
 END IF;
 -- Bloqueia TODOS os vínculos externos, inclusive os que possuem ON DELETE CASCADE.
 -- Apenas as próprias variações e os respectivos saldos são removidos com o produto.
 FOR r IN SELECT * FROM pg_catalog.pg_constraint
   WHERE contype='f' AND confrelid IN ('public."Produto"'::regclass,'public."Produto_Variacao"'::regclass,'public."Estoque"'::regclass)
     AND conrelid NOT IN ('public."Produto_Variacao"'::regclass,'public."Estoque"'::regclass)
 LOOP
   SELECT string_agg(format('a.%I=b.%I',a.attname,b.attname),' AND ' ORDER BY k.ord)
   INTO v_join FROM unnest(r.conkey,r.confkey) WITH ORDINALITY k(a,b,ord)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=r.conrelid AND a.attnum=k.a
     JOIN pg_catalog.pg_attribute b ON b.attrelid=r.confrelid AND b.attnum=k.b;
   v_filtro := CASE WHEN r.confrelid='public."Produto"'::regclass THEN 'id_prd' ELSE 'id_prd_fk' END;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s a JOIN %s b ON %s WHERE b.%I=$1)',
     r.conrelid::regclass,r.confrelid::regclass,v_join,v_filtro) INTO v_existe USING p_id;
   IF v_existe THEN RAISE EXCEPTION 'Produto com histórico ou vínculos em %. Desative-o para preservar os registros.',r.conrelid::regclass; END IF;
 END LOOP;
 DELETE FROM public."Produto" WHERE id_prd=p_id;
 RETURN jsonb_build_object('sucesso',true,'produto_id',p_id);
END; $fn$;

-- Bloqueio no servidor para novos pedidos/reservas de produtos retirados da venda.
-- Pedidos existentes continuam podendo ser pagos, produzidos, enviados e expirados.
CREATE OR REPLACE FUNCTION privado.mr_exigir_item_ativo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_ativo boolean;
BEGIN
 IF TG_TABLE_NAME='Reserva_Estoque' THEN
   IF NEW.status_res<>'reservada' THEN RETURN NEW; END IF;
 END IF;
 SELECT p.ativo_prd AND v.ativo_var INTO v_ativo FROM public."Produto" p
 JOIN public."Produto_Variacao" v ON v.id_prd_fk=p.id_prd
 WHERE p.id_prd=NEW.id_prd_fk AND v.id_var=NEW.id_var_fk FOR SHARE OF p,v;
 IF v_ativo IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Produto ou variação indisponível. Atualize o carrinho.' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END; $fn$;
REVOKE ALL ON FUNCTION privado.mr_exigir_item_ativo() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS mr_item_ativo ON public."Item_Pedido";
CREATE TRIGGER mr_item_ativo BEFORE INSERT ON public."Item_Pedido" FOR EACH ROW EXECUTE FUNCTION privado.mr_exigir_item_ativo();
DROP TRIGGER IF EXISTS mr_reserva_ativa ON public."Reserva_Estoque";
CREATE TRIGGER mr_reserva_ativa BEFORE INSERT ON public."Reserva_Estoque" FOR EACH ROW EXECUTE FUNCTION privado.mr_exigir_item_ativo();

REVOKE ALL ON FUNCTION public.mr_listar_produtos_admin() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mr_salvar_produto_admin(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mr_excluir_produto_admin(integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mr_listar_produtos_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mr_salvar_produto_admin(jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mr_excluir_produto_admin(integer,text) TO authenticated;

-- Mesma regra de embalagem/cotação, acrescentando a validação de ativo.
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
    IF NOT v_variacao.ativo_var OR NOT EXISTS (SELECT 1 FROM public."Produto" WHERE id_prd=v_linha.produto_id AND ativo_prd) THEN
      RAISE EXCEPTION 'Produto ou variação indisponível. Atualize o carrinho.' USING ERRCODE='22023';
    END IF;
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

NOTIFY pgrst, 'reload schema';
COMMIT;
