-- OpenBooks forward migration 0138_extension_drafts.
-- Author-owned package proposals are immutable. Activation records the exact
-- reviewed hash, checks the base release, and installs through the app store.
CREATE TABLE public.extension_drafts (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  extension_key text NOT NULL CHECK (extension_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  base_version_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK ((status='applied') = (applied_at IS NOT NULL)),
  FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) ON DELETE CASCADE
);
CREATE INDEX extension_drafts_author ON public.extension_drafts(org_id, created_by, created_at DESC);
ALTER TABLE public.extension_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extension_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.extension_drafts
  USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
CREATE FUNCTION public.extension_draft_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.org_id,NEW.created_by,NEW.extension_key,NEW.bundle,NEW.content_hash,NEW.base_version_id,NEW.reason,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.org_id,OLD.created_by,OLD.extension_key,OLD.bundle,OLD.content_hash,OLD.base_version_id,OLD.reason,OLD.created_at) THEN
    RAISE EXCEPTION 'Extension draft revisions are immutable; create a new revision';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status='draft' AND NEW.status IN ('applied','discarded')) THEN
    RAISE EXCEPTION 'Invalid extension draft transition';
  END IF;
  IF (NEW.status='applied') IS DISTINCT FROM (NEW.applied_at IS NOT NULL) OR
     (OLD.status='applied' AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'Invalid extension activation timestamp';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extension_draft_immutable BEFORE UPDATE ON public.extension_drafts
  FOR EACH ROW EXECUTE FUNCTION public.extension_draft_immutable();
