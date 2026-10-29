-- Apenas consulta. Pode executar antes de instalar o pacote 02.
-- Envie o resultado e informe quantos potes cabem em cada caixa.
-- Medidas em centímetros e peso vazio em quilogramas.
SELECT id_emb, nome_emb, comprimento_cm_emb, largura_cm_emb, altura_cm_emb,
       peso_vazio_kg_emb, ativo_emb
FROM public."Embalagem"
ORDER BY id_emb;
