-- Refuse a partially installed project-binding migration before changing provision identities.
SELECT 'provision project binding already exists without its migration' AS issue
WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='provision_obligations' AND column_name='project_id')
  OR to_regprocedure('public.provision_project_binding()') IS NOT NULL;
