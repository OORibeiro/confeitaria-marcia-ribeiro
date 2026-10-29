-- PASSO 1: execute esta consulta e confira as embalagens já cadastradas.
SELECT id_emb, nome_emb, comprimento_cm_emb, largura_cm_emb, altura_cm_emb,
       peso_vazio_kg_emb, ativo_emb
FROM public."Embalagem" ORDER BY id_emb;

-- PASSO 2: após conferir a capacidade real das caixas, configure as faixas.
-- Os comandos abaixo estão comentados de propósito: substitua os marcadores
-- por IDs reais, quantidade de potes que cabe na caixa e peso medido da proteção.
-- Nenhum tamanho ou peso de caixa é inventado automaticamente.
--
-- INSERT INTO privado."Regra_Embalagem_Frete"
--   (quantidade_min, quantidade_max, id_emb_fk, peso_protecao_kg)
-- VALUES
--   (<MIN_POTES>, <MAX_POTES>, <ID_DA_EMBALAGEM>, <PESO_DA_PROTECAO_EM_KG>)
-- ON CONFLICT (quantidade_min, quantidade_max, id_emb_fk)
-- DO UPDATE SET peso_protecao_kg = EXCLUDED.peso_protecao_kg;
--
-- Se não usar proteção adicional, informe 0. O peso vazio da caixa vem de
-- Embalagem, e o peso dos produtos vem de Produto_Variacao.peso_var.
-- Configure faixas que cubram as quantidades de 1 a 10 que você pretende vender.
-- Se houver mais de uma caixa elegível, usa a de menor volume externo.

-- PASSO 3: esta consulta mostra as quantidades que já têm embalagem ativa.
SELECT qtd AS quantidade_potes, EXISTS (
  SELECT 1 FROM privado."Regra_Embalagem_Frete" r
  JOIN public."Embalagem" e ON e.id_emb = r.id_emb_fk
  WHERE e.ativo_emb AND qtd BETWEEN r.quantidade_min AND r.quantidade_max
) AS embalagem_configurada FROM generate_series(1,10) qtd;
