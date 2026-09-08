-- OpenBooks forward migration 0097_role_reference_integrity.
-- Refuse invalid legacy references with exact evidence; never rewrite grants.
DO $preflight$
DECLARE violation record;
BEGIN
  SELECT * INTO violation FROM (
    SELECT 'app_roles.org_id'::text AS relationship, r.id AS child_id,
           r.org_id AS child_org, r.org_id AS referenced_id
      FROM public.app_roles r LEFT JOIN public.orgs o ON o.id = r.org_id
     WHERE o.id IS NULL
    UNION ALL
    SELECT 'role_assignments.org_id', a.id, a.org_id, a.org_id
      FROM public.role_assignments a LEFT JOIN public.orgs o ON o.id = a.org_id
     WHERE o.id IS NULL
    UNION ALL
    SELECT 'role_assignments.user_id', a.id, a.org_id, a.user_id
      FROM public.role_assignments a
      LEFT JOIN public.users u ON u.id = a.user_id AND u.org_id = a.org_id
     WHERE u.id IS NULL
    UNION ALL
    SELECT 'role_assignments.role_id', a.id, a.org_id, a.role_id
      FROM public.role_assignments a
      LEFT JOIN public.app_roles r ON r.id = a.role_id AND r.org_id = a.org_id
     WHERE r.id IS NULL
  ) invalid ORDER BY relationship, child_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'role reference integrity: % row % in organization % references missing or foreign parent %; reconcile this grant before retrying migration 0097',
      violation.relationship, violation.child_id, violation.child_org, violation.referenced_id
      USING ERRCODE = '23503';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX users_org_id_id_unique ON public.users(org_id, id);
CREATE UNIQUE INDEX app_roles_org_id_id_unique ON public.app_roles(org_id, id);

ALTER TABLE public.app_roles ADD CONSTRAINT app_roles_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE public.role_assignments ADD CONSTRAINT role_assignments_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE public.role_assignments ADD CONSTRAINT role_assignments_user_id_fkey
  FOREIGN KEY (org_id, user_id) REFERENCES public.users(org_id, id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE public.role_assignments ADD CONSTRAINT role_assignments_role_id_fkey
  FOREIGN KEY (org_id, role_id) REFERENCES public.app_roles(org_id, id) ON DELETE NO ACTION
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.app_roles VALIDATE CONSTRAINT app_roles_org_id_fkey;
ALTER TABLE public.role_assignments VALIDATE CONSTRAINT role_assignments_org_id_fkey;
ALTER TABLE public.role_assignments VALIDATE CONSTRAINT role_assignments_user_id_fkey;
ALTER TABLE public.role_assignments VALIDATE CONSTRAINT role_assignments_role_id_fkey;
SELECT public.openbooks_refresh_query_catalog();
