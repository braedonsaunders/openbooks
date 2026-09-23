-- OpenBooks forward migration 0277_pdf_template_default_and_revision.
--
-- Two PDF templates of one record type could both be the default: the
-- collection POST and the [id] PATCH each cleared the old default and set
-- the new one in separate statements with no mutual exclusion, so two
-- concurrent default-sets both committed and the resolver picked one
-- arbitrarily. A partial unique index now refuses a second default per
-- (org, record type) at storage; the routes serialize swaps under an
-- advisory transaction lock, so the index is a backstop, not the user
-- experience. Pre-existing duplicates are resolved the way the print
-- resolver already picks (resolvePdfTemplate: active templates ordered by
-- is_default desc, name, first default wins): the lowest-named active
-- default is kept — or, when no default is active, the lowest-named
-- default — the rest are demoted with one audit_log row each, so no
-- upgrade changes which design an org's records print with. pdf_templates
-- also gains the revision counter PATCH bumps on every applied change, so
-- an issued PDF can name the exact template version that produced it.
-- Existing rows start at 1.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $$
DECLARE
  grp record;
  keep_id uuid;
  keep_name text;
  dem record;
BEGIN
  -- More than one default per (org, record type): keep exactly the template
  -- the resolver returns today and demote the rest with audit evidence.
  -- Names are unique per (org, record type), so the keep is deterministic.
  FOR grp IN
    SELECT org_id, record_type
      FROM pdf_templates
     WHERE is_default
     GROUP BY org_id, record_type
    HAVING count(*) > 1
  LOOP
    SELECT id, name INTO keep_id, keep_name
      FROM pdf_templates
     WHERE org_id = grp.org_id AND record_type = grp.record_type AND is_default
     ORDER BY (CASE WHEN is_active THEN 0 ELSE 1 END), name
     LIMIT 1;
    FOR dem IN
      SELECT id, name FROM pdf_templates
       WHERE org_id = grp.org_id AND record_type = grp.record_type
         AND is_default AND id <> keep_id
       ORDER BY name
    LOOP
      UPDATE pdf_templates SET is_default = false, updated_at = now() WHERE id = dem.id;
      INSERT INTO audit_log (org_id, table_name, row_id, action, changes, actor_id)
      VALUES (grp.org_id, 'pdf_templates', dem.id, 'update',
              jsonb_build_object(
                'before', jsonb_build_object('is_default', true),
                'after', jsonb_build_object('is_default', false),
                'reason', 'migration 0277: duplicate default demoted; kept default "' || keep_name ||
                          '" (' || keep_id || ') for record type ' || grp.record_type),
              NULL);
    END LOOP;
  END LOOP;
END
$$;

-- Exactly one default design per (org, record type). A second default is a
-- configuration error, not a second default: storage refuses it, the route
-- names it. A partial unique INDEX, because a UNIQUE constraint cannot
-- carry a WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS pdf_templates_one_default_per_kind
  ON public.pdf_templates (org_id, record_type) WHERE is_default;

ALTER TABLE pdf_templates ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
