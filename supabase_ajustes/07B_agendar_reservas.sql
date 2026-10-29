-- Primeiro habilite pg_cron em Integrations > Cron. Execute como postgres no SQL Editor.
BEGIN;
DO $install$
DECLARE j record; v_comando text; v_job bigint;
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE EXCEPTION 'Habilite pg_cron em Integrations > Cron e execute novamente este arquivo.';
 END IF;
 IF to_regprocedure('privado.processar_reservas_vencidas(integer)') IS NULL THEN
  RAISE EXCEPTION 'Execute primeiro 07A_rotina_reservas.sql.';
 END IF;
 PERFORM pg_advisory_xact_lock(705071,2);
 -- Não altera tarefas de outro banco nem tarefas com lógica adicional.
 FOR j IN SELECT * FROM cron.job WHERE jobname='mr-expirar-reservas-v1'
  OR (database=current_database() AND active AND command ~* '(expirar_reservas_vencidas|processar_reservas_vencidas)')
 LOOP
  IF j.database IS DISTINCT FROM current_database() OR j.username IS DISTINCT FROM current_user THEN
   RAISE EXCEPTION 'A tarefa % (id %) pertence a outro banco ou usuário. Envie o resultado de 07C; nenhuma tarefa foi alterada.',j.jobname,j.jobid;
  END IF;
  v_comando:=regexp_replace(lower(j.command),'[[:space:]]','','g');
  IF v_comando NOT IN ('selectprivado.expirar_reservas_vencidas();','selectprivado.expirar_reservas_vencidas()') THEN
   RAISE EXCEPTION 'A tarefa % (id %) precisa de revisão antes do agendamento; envie o resultado do arquivo 07C. Nenhuma tarefa foi alterada.',j.jobname,j.jobid;
  END IF;
 END LOOP;
 -- Desativa apenas cópias dedicadas da chamada antiga, conservando seus registros.
 FOR j IN SELECT * FROM cron.job WHERE database=current_database() AND active
  AND jobname IS DISTINCT FROM 'mr-expirar-reservas-v1'
  AND regexp_replace(lower(command),'[[:space:]]','','g') IN ('selectprivado.expirar_reservas_vencidas();','selectprivado.expirar_reservas_vencidas()')
 LOOP
  PERFORM cron.alter_job(j.jobid,active:=false);
 END LOOP;
 v_job:=cron.schedule('mr-expirar-reservas-v1','* * * * *','SELECT privado.expirar_reservas_vencidas();');
 -- schedule atualiza a definição existente; garante reativação se havia sido pausada.
 PERFORM cron.alter_job(v_job,active:=true);
END $install$;
COMMIT;
SELECT jobid,jobname,schedule,active,database,username FROM cron.job
WHERE jobname='mr-expirar-reservas-v1' AND database=current_database();
