-- Per-user page layout preferences: reorder + show/hide of a page's panels
-- (cockpits, module homes). One row per (org, user, page); layout jsonb holds
-- { order: string[], hidden: string[] }. Generic on purpose — every cockpit
-- shares this store.

CREATE TABLE IF NOT EXISTS user_page_layouts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  page text NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS user_page_layouts_unique
  ON user_page_layouts (org_id, user_id, page);

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
  EXECUTE 'alter table user_page_layouts enable row level security';
  EXECUTE 'alter table user_page_layouts force row level security';
  EXECUTE 'drop policy if exists org_isolation on user_page_layouts';
  EXECUTE format('create policy org_isolation on user_page_layouts using (%s) with check (%s)', body, body);
END $$;
