-- OpenBooks forward migration 0105_page_spec_drafts.
--
-- A layout an author is still working on, so they can SEE it before anyone
-- else does. The editor writes a draft here and then opens the real route
-- with `?layoutPreview=1`; the renderer prefers the caller's own draft over
-- the org's active spec for that one request. The preview is therefore the
-- actual page — its chrome, its data, its interactions — rather than a second
-- rendering path that could drift from the first.
--
-- Scoped to ONE USER, not to the org. A draft is unreviewed work: it must not
-- change what a colleague sees, and it must not become a way to show someone
-- else a layout they did not ask for. Publishing is a separate, audited act
-- against page_specs.
--
-- Short-lived by construction. Rows carry `created_at` and the writer deletes
-- anything older than the preview window, so an abandoned draft stops
-- applying on its own rather than lingering as a layout its author forgot
-- they were wearing.

CREATE TABLE public.page_spec_drafts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    route text NOT NULL,
    spec jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_spec_drafts_route_shape CHECK (route ~ '^/[A-Za-z0-9\-_/\[\]().]*$'),
    CONSTRAINT page_spec_drafts_spec_object CHECK (jsonb_typeof(spec) = 'object')
);

ALTER TABLE public.page_spec_drafts
    ADD CONSTRAINT page_spec_drafts_pkey PRIMARY KEY (id);

ALTER TABLE public.page_spec_drafts
    ADD CONSTRAINT page_spec_drafts_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES public.orgs (id)
    ON DELETE CASCADE;

ALTER TABLE public.page_spec_drafts
    ADD CONSTRAINT page_spec_drafts_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES public.users (id)
    ON DELETE CASCADE;

-- One draft per author per route: previewing again replaces what you were
-- previewing, which is the only behaviour that does not accumulate stale
-- layouts nobody can see to clean up.
CREATE UNIQUE INDEX page_spec_drafts_owner_route ON public.page_spec_drafts
    USING btree (org_id, user_id, route);

-- The sweep the writer runs looks up expired rows by age alone.
CREATE INDEX page_spec_drafts_created ON public.page_spec_drafts USING btree (created_at);

ALTER TABLE public.page_spec_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.page_spec_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON public.page_spec_drafts
    AS permissive
    FOR all
    TO PUBLIC
    USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))
    WITH CHECK ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)));

COMMENT ON TABLE public.page_spec_drafts IS
  'openbooks:page_spec_drafts:v1 - an author''s unpublished ViewSpec layout, applied only to that author''s own request when it carries ?layoutPreview=1; expires by age';

COMMENT ON COLUMN public.page_spec_drafts.user_id IS
  'The author. A draft is unreviewed work and must never change what a colleague sees.';

COMMENT ON COLUMN public.page_spec_drafts.spec IS
  'The candidate PageSpec. Validated against the closed schema AND the host registries before it is stored, and validated again before it renders.';
