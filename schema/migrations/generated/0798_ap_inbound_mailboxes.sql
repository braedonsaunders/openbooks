-- Inbound email addresses for AP capture per legal entity with their accountable owners, sealed signing secrets, the inbound message log with signature evidence and delivery leases, the capture's receiving entity, and the effective-dated auto-post policy.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- A capture now arrives by upload or by email. An emailed capture names the
-- legal entity whose address received it, so its draft bill books to that
-- entity instead of requiring a purchase order to identify one.
ALTER TABLE public.ap_capture_items DROP CONSTRAINT ap_capture_items_source_check;
ALTER TABLE public.ap_capture_items
  ADD CONSTRAINT ap_capture_items_source_check CHECK (source IN ('upload', 'email'));
ALTER TABLE public.ap_capture_items ADD COLUMN subsidiary_id uuid;
ALTER TABLE public.ap_capture_items
  ADD CONSTRAINT ap_capture_items_subsidiary_tenant_fkey
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id)
  DEFERRABLE INITIALLY DEFERRED;
COMMENT ON COLUMN public.ap_capture_items.subsidiary_id IS
  'Receiving legal entity named by the intake channel (an inbound address belongs to one entity); null for uploads.';

CREATE TABLE public.ap_capture_mailboxes (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  subsidiary_id uuid NOT NULL,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  email_address text CHECK (email_address IS NULL OR (length(email_address) BETWEEN 3 AND 320 AND position('@' IN email_address) > 1)),
  token text NOT NULL CHECK (token ~ '^[a-z2-7]{32}$'),
  provider text NOT NULL CHECK (provider IN ('postmark', 'mailgun', 'sendgrid', 'generic')),
  allowed_senders jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_senders) = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  rate_window_start timestamptz,
  rate_window_count integer NOT NULL DEFAULT 0 CHECK (rate_window_count >= 0),
  owner_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT ap_capture_mailboxes_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT ap_capture_mailboxes_token_unique UNIQUE (token),
  CONSTRAINT ap_capture_mailboxes_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ap_capture_mailboxes_owner_fkey
    FOREIGN KEY (org_id, owner_user_id) REFERENCES public.users (org_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ap_capture_mailboxes_created_by_fkey
    FOREIGN KEY (org_id, created_by) REFERENCES public.users (org_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ap_capture_mailboxes_updated_by_fkey
    FOREIGN KEY (org_id, updated_by) REFERENCES public.users (org_id, id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ap_capture_mailboxes_subsidiary_idx ON public.ap_capture_mailboxes (org_id, subsidiary_id);
COMMENT ON TABLE public.ap_capture_mailboxes IS
  'Inbound email address for AP capture. The unguessable token authenticates the provider webhook; attachments become captures for the address''s legal entity.';
COMMENT ON COLUMN public.ap_capture_mailboxes.owner_user_id IS
  'User captures from this address are attributed to. Receipt refuses unless the owner is active, holds AP create and can access the address''s legal entity.';

CREATE TABLE public.ap_capture_mailbox_credentials (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  mailbox_id uuid NOT NULL,
  sealed_secret text NOT NULL CHECK (length(sealed_secret) BETWEEN 8 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT ap_capture_mailbox_credentials_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT ap_capture_mailbox_credentials_mailbox_unique UNIQUE (org_id, mailbox_id),
  CONSTRAINT ap_capture_mailbox_credentials_mailbox_fkey
    FOREIGN KEY (org_id, mailbox_id) REFERENCES public.ap_capture_mailboxes (org_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ap_capture_mailbox_credentials_created_by_fkey
    FOREIGN KEY (org_id, created_by) REFERENCES public.users (org_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ap_capture_mailbox_credentials_updated_by_fkey
    FOREIGN KEY (org_id, updated_by) REFERENCES public.users (org_id, id)
    DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE public.ap_capture_mailbox_credentials IS
  'Provider signing secret for one inbound address, sealed with the organization data key. Kept apart from the address so configuration reads never carry it.';

CREATE TABLE public.ap_capture_inbound_messages (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  mailbox_id uuid NOT NULL,
  message_id text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 998),
  provider text NOT NULL CHECK (provider IN ('postmark', 'mailgun', 'sendgrid', 'generic')),
  from_address text CHECK (from_address IS NULL OR length(from_address) <= 320),
  subject text CHECK (subject IS NULL OR length(subject) <= 998),
  attachment_count integer NOT NULL CHECK (attachment_count >= 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  signature_verified boolean NOT NULL DEFAULT false,
  provider_nonce text CHECK (provider_nonce IS NULL OR length(provider_nonce) BETWEEN 1 AND 512),
  received_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claim_attempt integer NOT NULL DEFAULT 1 CHECK (claim_attempt >= 1),
  outcome text NOT NULL DEFAULT 'received'
    CHECK (outcome IN ('received', 'captured', 'rejected_sender', 'no_attachments', 'duplicate', 'error')),
  outcome_reason text CHECK (outcome_reason IS NULL OR length(outcome_reason) <= 1000),
  capture_item_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  processed_at timestamptz,
  CONSTRAINT ap_capture_inbound_messages_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT ap_capture_inbound_messages_message_unique UNIQUE (org_id, mailbox_id, message_id),
  CONSTRAINT ap_capture_inbound_messages_processed_check
    CHECK ((outcome = 'received') = (processed_at IS NULL)),
  CONSTRAINT ap_capture_inbound_messages_mailbox_fkey
    FOREIGN KEY (org_id, mailbox_id) REFERENCES public.ap_capture_mailboxes (org_id, id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ap_capture_inbound_messages_recent_idx
  ON public.ap_capture_inbound_messages (org_id, received_at DESC);
-- A provider signature that covers only a timestamp and a one-time token
-- (Mailgun) is accepted once per address; a second message presenting the
-- same token is a replay.
CREATE UNIQUE INDEX ap_capture_inbound_messages_nonce_unique
  ON public.ap_capture_inbound_messages (org_id, mailbox_id, provider_nonce)
  WHERE provider_nonce IS NOT NULL;
COMMENT ON TABLE public.ap_capture_inbound_messages IS
  'One row per inbound AP email, idempotent on the address and message id. The received facts are immutable; the outcome is written once when processing finishes.';
COMMENT ON COLUMN public.ap_capture_inbound_messages.signature_verified IS
  'True when the address had a provider signing secret and the delivery''s signature verified against it. Only verified email may auto-post.';
COMMENT ON COLUMN public.ap_capture_inbound_messages.claimed_at IS
  'Processing lease. A message still received after the lease expires may be claimed again by a provider retry.';

-- The received facts never change, an outcome is written exactly once, and
-- an unfinished message's processing claim only moves forward.
CREATE FUNCTION public.ap_capture_inbound_message_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF OLD.outcome <> 'received' THEN
    RAISE EXCEPTION 'A processed inbound AP email is retained as recorded.' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.from_address IS DISTINCT FROM OLD.from_address
     OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.attachment_count IS DISTINCT FROM OLD.attachment_count
     OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
     OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
     OR NEW.provider_nonce IS DISTINCT FROM OLD.provider_nonce
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'Inbound AP email facts are immutable; only the processing outcome may be recorded.' USING ERRCODE = '23514';
  END IF;
  IF NEW.claim_attempt < OLD.claim_attempt THEN
    RAISE EXCEPTION 'An inbound AP email processing claim only moves forward.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ap_capture_inbound_messages_immutable
  BEFORE UPDATE ON public.ap_capture_inbound_messages
  FOR EACH ROW EXECUTE FUNCTION public.ap_capture_inbound_message_guard();

CREATE TABLE public.ap_capture_autopost_policies (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  enabled boolean NOT NULL,
  clean_streak integer NOT NULL CHECK (clean_streak BETWEEN 2 AND 20),
  max_amount numeric(19,4) CHECK (max_amount IS NULL OR max_amount > 0),
  max_amount_currency text CHECK (max_amount_currency IS NULL OR max_amount_currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT ap_capture_autopost_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT ap_capture_autopost_policies_effective_unique UNIQUE (org_id, effective_from),
  CONSTRAINT ap_capture_autopost_policies_limit_currency
    CHECK ((max_amount IS NULL) = (max_amount_currency IS NULL))
);
COMMENT ON TABLE public.ap_capture_autopost_policies IS
  'Effective-dated policy for posting captured bills from vendors whose recent captures were accepted unchanged and posted. No version reads as off.';
CREATE TRIGGER ap_capture_autopost_policies_immutable
  BEFORE UPDATE OR DELETE ON public.ap_capture_autopost_policies
  FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();

ALTER TABLE public.ap_capture_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_capture_mailboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.ap_capture_mailboxes
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.ap_capture_mailboxes IS 'openbooks:org_isolation:v1';

ALTER TABLE public.ap_capture_mailbox_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_capture_mailbox_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.ap_capture_mailbox_credentials
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.ap_capture_mailbox_credentials IS 'openbooks:org_isolation:v1';

ALTER TABLE public.ap_capture_inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_capture_inbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.ap_capture_inbound_messages
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.ap_capture_inbound_messages IS 'openbooks:org_isolation:v1';

ALTER TABLE public.ap_capture_autopost_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_capture_autopost_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.ap_capture_autopost_policies
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.ap_capture_autopost_policies IS 'openbooks:org_isolation:v1';

CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.ap_capture_mailboxes
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.ap_capture_mailbox_credentials
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.ap_capture_inbound_messages
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.ap_capture_autopost_policies
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
