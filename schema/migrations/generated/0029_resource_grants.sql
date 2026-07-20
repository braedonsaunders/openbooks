-- File Cabinet access grants: per-folder / per-file sharing beyond the org-role
-- baseline. A grant gives a principal (user or role) an access tier
-- (viewer < editor < manager) on a folder or file. Folder grants inherit to
-- descendants; enforced in the query layer, RLS stays org-isolation only.

CREATE TABLE IF NOT EXISTS resource_grants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  resource_type text NOT NULL,   -- 'folder' | 'file'
  resource_id uuid NOT NULL,
  principal_type text NOT NULL,  -- 'user' | 'role'
  principal_id uuid NOT NULL,
  access text NOT NULL,          -- 'viewer' | 'editor' | 'manager'
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_grants_unique
  ON resource_grants (org_id, resource_type, resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS resource_grants_resource
  ON resource_grants (org_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS resource_grants_principal
  ON resource_grants (org_id, principal_type, principal_id);

-- Org-isolation RLS (same policy body as every other org-owned table).
DO $$
DECLARE
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
BEGIN
  EXECUTE 'alter table resource_grants enable row level security';
  EXECUTE 'alter table resource_grants force row level security';
  EXECUTE 'drop policy if exists org_isolation on resource_grants';
  EXECUTE format('create policy org_isolation on resource_grants using (%s) with check (%s)', body, body);
END $$;
