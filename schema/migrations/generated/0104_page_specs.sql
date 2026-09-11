-- OpenBooks forward migration 0104_page_specs.
--
-- Tenant-authored page layouts. Every page in the app renders from a loader
-- and a ViewSpec; this is where a tenant stores its own spec for a route,
-- which the renderer uses in place of the built-in one.
--
-- What a row here can and cannot do is decided by the spec language, not by
-- this table. A spec names blocks and binds fields that the page's LOADER
-- already resolved; it carries no conditionals, no arithmetic, no function
-- values, no component references and no capability objects, and its field
-- refs are dot paths with a prototype-pollution guard. So a row is a layout,
-- not a program, and it cannot reach data its page did not already load —
-- which is the property that makes storing one safe.
--
-- One active spec per route per org. `route` is the Next.js route PATTERN
-- (`/apps/[key]`), never a concrete url, so one row customizes the page for
-- every record it renders.

CREATE TABLE public.page_specs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    route text NOT NULL,
    spec jsonb NOT NULL,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT page_specs_route_shape CHECK (route ~ '^/[A-Za-z0-9\-_/\[\]().]*$'),
    CONSTRAINT page_specs_spec_object CHECK (jsonb_typeof(spec) = 'object')
);

ALTER TABLE public.page_specs
    ADD CONSTRAINT page_specs_pkey PRIMARY KEY (id);

ALTER TABLE public.page_specs
    ADD CONSTRAINT page_specs_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES public.orgs (id)
    ON DELETE CASCADE;

-- One ACTIVE override per route. Inactive rows are kept so a tenant can turn
-- a customization off without losing the work, and so the audit trail has
-- something to point at.
CREATE UNIQUE INDEX page_specs_active_route ON public.page_specs
    USING btree (org_id, route) WHERE (is_active);

CREATE INDEX page_specs_org ON public.page_specs USING btree (org_id, route);

ALTER TABLE public.page_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.page_specs FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON public.page_specs
    AS permissive
    FOR all
    TO PUBLIC
    USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))
    WITH CHECK ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)));

COMMENT ON TABLE public.page_specs IS
  'openbooks:page_specs:v1 - tenant-authored ViewSpec page layouts; one active spec per route pattern per org, rendered in place of the built-in spec by ModuleView';

COMMENT ON COLUMN public.page_specs.route IS
  'Next.js route PATTERN the spec replaces (/apps/[key]), never a concrete url';

COMMENT ON COLUMN public.page_specs.spec IS
  'The PageSpec document. Validated against the closed schema AND the host widget/frame registries before it is stored, and validated again before it renders.';
