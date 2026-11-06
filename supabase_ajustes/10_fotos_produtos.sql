-- Requer a atualização 09. Execute apenas este arquivo para instalar as fotos.
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('privado.eh_admin()') IS NULL THEN
   RAISE EXCEPTION 'A função de administradores não foi encontrada.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity) THEN
   RAISE EXCEPTION 'RLS de storage.objects precisa estar habilitado antes de continuar.';
 END IF;
END $$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('mr-produtos-fotos','mr-produtos-fotos',true,5242880,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=true,file_size_limit=5242880,
 allowed_mime_types=EXCLUDED.allowed_mime_types;

-- Wrapper evita conceder acesso dos clientes ao esquema privado.
CREATE OR REPLACE FUNCTION public.mr_admin_fotos()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT auth.uid() IS NOT NULL AND coalesce(privado.eh_admin(),false); $$;
REVOKE ALL ON FUNCTION public.mr_admin_fotos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mr_admin_fotos() TO anon,authenticated;

-- Esta restrição também protege o bucket caso existam policies permissivas antigas.
-- Outros buckets continuam sujeitos às suas próprias policies.
DROP POLICY IF EXISTS mr_fotos_restricao_admin ON storage.objects;
CREATE POLICY mr_fotos_restricao_admin ON storage.objects AS RESTRICTIVE
FOR ALL TO anon,authenticated
USING (bucket_id <> 'mr-produtos-fotos' OR (SELECT public.mr_admin_fotos()))
WITH CHECK (bucket_id <> 'mr-produtos-fotos' OR (SELECT public.mr_admin_fotos()));

DROP POLICY IF EXISTS mr_fotos_admin_upload ON storage.objects;
CREATE POLICY mr_fotos_admin_upload ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
 bucket_id='mr-produtos-fotos'
 AND (SELECT public.mr_admin_fotos())
 AND split_part(name,'/',1)=(SELECT auth.uid())::text
 AND name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|png|jpg|jpeg)$'
);
-- Sem upsert: cada foto recebe nome novo. Não concedemos UPDATE/DELETE.
-- Leitura pública das imagens é feita pelo endpoint público do Storage.
NOTIFY pgrst,'reload schema';
COMMIT;
