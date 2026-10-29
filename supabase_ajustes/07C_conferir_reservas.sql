-- Somente leitura. Execute depois de 07A e 07B. Não envia credenciais nem dados de clientes.
SELECT jobid,jobname,schedule,active,database,username FROM cron.job
WHERE jobname='mr-expirar-reservas-v1'
 OR (database=current_database() AND command ~* '(expirar_reservas_vencidas|processar_reservas_vencidas)') ORDER BY jobid;

SELECT d.jobid,d.runid,d.status,d.start_time,d.end_time,d.return_message
FROM cron.job_run_details d JOIN cron.job j USING(jobid)
WHERE j.jobname='mr-expirar-reservas-v1' AND j.database=current_database()
ORDER BY d.runid DESC LIMIT 10;

SELECT * FROM privado."Execucao_Expiracao_Reserva" ORDER BY id DESC LIMIT 10;
SELECT pedido_id,ultima_tentativa,tentativas,codigo_erro,mensagem_erro
FROM privado."Falha_Expiracao_Reserva" ORDER BY ultima_tentativa DESC LIMIT 20;

-- Mostra pendências para conferência; não libera nenhuma delas.
SELECT p.id_pdd AS pedido_id,p.status_pdd,
 count(*) FILTER(WHERE r.status_res='reservada' AND r.expira_em<=clock_timestamp()) AS reservas_vencidas,
 count(*) FILTER(WHERE r.status_res='confirmada') AS reservas_confirmadas,
 bool_or(r.status_res='reservada' AND r.expira_em>clock_timestamp()) AS tem_reserva_ainda_valida,
 EXISTS(SELECT 1 FROM public."Pagamento" pg WHERE pg.id_pdd_fk=p.id_pdd AND (pg.status_pag='aprovado' OR pg.pago_em IS NOT NULL)) AS tem_pagamento_confirmado,
 EXISTS(SELECT 1 FROM public."Venda" v WHERE v.id_pdd_fk=p.id_pdd AND v.status_vnd='aprovado') AS tem_venda_aprovada
FROM public."Pedido" p JOIN public."Reserva_Estoque" r ON r.id_pdd_fk=p.id_pdd
GROUP BY p.id_pdd HAVING count(*) FILTER(WHERE r.status_res='reservada' AND r.expira_em<=clock_timestamp())>0
ORDER BY p.id_pdd LIMIT 30;
