-- OpenBooks forward migration 0173_platform_settings.
--
-- The deployment's own operator settings — the first configuration in this
-- schema that belongs to the INSTALLATION rather than to an organization.
--
-- The motivating case is in-app issue reporting (@braedonsaunders/appkit-feedback):
-- the destination is one product tracker for the whole deployment, chosen by
-- the operator who runs it, and every organization's reports go to it. Putting
-- that on `orgs.settings` would create one destination per tenant and let any
-- org admin redirect the operator's issue tracker, which is exactly the
-- parallel source of truth this repository forbids.
--
-- WHY IT HAS NO org_id. Deliberately org-less, and three subsystems already
-- read that fact correctly: per-org backup archives enumerate tables with an
-- org_id column (engine/src/backup.ts) plus a small explicit org-less
-- allowlist, sandbox cloning keys on the same column (engine/src/sandbox/
-- catalog.ts), and org teardown likewise. So installation-owned settings are
-- neither carried into a tenant archive, copied into a sandbox, nor deleted
-- with an organization — all three of which would be wrong.
--
-- WHY A SINGLETON ROW. There is exactly one deployment. A CHECK-pinned primary
-- key makes "the settings row" addressable without a lookup and makes a second
-- row impossible, so no reader ever has to decide which row wins.
--
-- ACCESS. RLS is on with a bypass-only policy: the only way in is trusted
-- server-side code inside withBypassContext/withBypass, which is where the
-- super-admin gate already lives (web/lib/super-admin.ts). A tenant session
-- carries app.current_org and no bypass, so it matches no row — reads return
-- nothing and writes are refused by the database, not only by the UI.
--
-- SECRETS. Credentials inside `settings` are AES-256-GCM sealed by
-- engine/src/secrets.ts under OPENBOOKS_DATA_KEY before they are written, the
-- same wire format as every other stored credential. No plaintext token is
-- ever persisted here, and no reader returns one to a browser.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.platform_settings (
    id text DEFAULT 'platform'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT platform_settings_pkey PRIMARY KEY (id),
    CONSTRAINT platform_settings_singleton CHECK (id = 'platform'::text)
);

COMMENT ON TABLE public.platform_settings IS
  'Installation-owned operator configuration (0173): one singleton row for the whole deployment, deliberately org-less so per-org backup, sandbox cloning and org teardown all skip it. Bypass-only RLS; embedded credentials are sealed by engine/src/secrets.ts';

COMMENT ON COLUMN public.platform_settings.settings IS
  'Operator settings by area, e.g. {"feedback": {...}} for the in-app issue reporter. Credentials inside are enc:v1 sealed, never plaintext';

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.platform_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_bypass_only ON public.platform_settings;
CREATE POLICY platform_bypass_only ON public.platform_settings
  USING (current_setting('app.bypass_rls'::text, true) = 'on'::text)
  WITH CHECK (current_setting('app.bypass_rls'::text, true) = 'on'::text);

-- The row exists from the first boot, so every reader is a plain select and
-- every writer is a plain update. An install that never opens the operator
-- console keeps the empty settings object, which means "nothing configured".
INSERT INTO public.platform_settings (id) VALUES ('platform')
  ON CONFLICT (id) DO NOTHING;
