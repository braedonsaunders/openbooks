-- OpenBooks forward migration 0107_modules.
--
-- Modules are the org-scoped unit of composed change: an installable package
-- whose manifest declares CONTRIBUTIONS — pages, panels, record types, fields,
-- reports, cards, jobs, endpoints, hooks, flows, agents, permissions, settings
-- — each of which projects into a table this app already ships. page_specs
-- (0104) is the first contribution kind and already proves the projection
-- pattern end to end: a module version declares a page, the installer writes
-- the projection row, the renderer reads it. apps (the sandboxed iframe
-- packages) stay exactly as they are; a module is how their surfaces and this
-- app's own future surfaces register, not a second runtime.
--
-- The split between the two tables below is the whole design:
--
--   modules         — the org's RELATIONSHIP with a module: key, display
--                     identity, granted permissions, and which version is
--                     active. Mutable, small, one row per installed module.
--   module_versions — the immutable record of what a version said. Every
--                     install and upgrade APPENDS one row; nothing ever
--                     rewrites a row here. A version that is superseded keeps
--                     its manifest so a rollback can re-apply the exact bytes
--                     that ran before, and so an audit trail written against
--                     version N keeps pointing at version N forever.
--
-- Immutability is enforced at the storage boundary (BEFORE UPDATE trigger),
-- not only in the installer, because "the manifest an approval was granted
-- for" and "the manifest in the table" must be the same document for the life
-- of the row. Status transitions on module_versions are the one permitted
-- mutation, and only along the lifecycle this platform's approval flow owns:
-- pending → active → superseded/rolled-back. The installer, not a direct SQL
-- writer, owns the transitions; the trigger holds the invariant so nothing
-- else can drift it.
--
-- modules and module_versions reference each other (active_version_id up,
-- module_id down), so the tables are created first and the up-edge is added
-- once both exist — the same ordering apps/app_versions needed.

CREATE TABLE public.modules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    icon_key text DEFAULT 'box'::text NOT NULL,
    status text DEFAULT 'installed'::text NOT NULL,
    active_version_id uuid,
    granted_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT modules_key_slug CHECK ((key ~ '^[a-z][a-z0-9-]*$'::text)),
    CONSTRAINT modules_key_length CHECK (((length(key) >= 2) AND (length(key) <= 64))),
    CONSTRAINT modules_status_shape CHECK ((status = ANY (ARRAY['installed'::text, 'disabled'::text])))
);

ALTER TABLE public.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (id);

ALTER TABLE public.modules
    ADD CONSTRAINT modules_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES public.orgs (id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX modules_org_key ON public.modules USING btree (org_id, key);

CREATE INDEX modules_org_status ON public.modules USING btree (org_id, status);

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- module_versions and page_specs pin their parent rows tenant-coherently by
-- (org_id, id), so both parents publish that key explicitly.
CREATE UNIQUE INDEX modules_org_id_id_unique ON public.modules USING btree (org_id, id);

ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.modules FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON public.modules
    AS permissive
    FOR all
    TO PUBLIC
    USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))
    WITH CHECK ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)));

COMMENT ON TABLE public.modules IS
  'openbooks:modules:v1 - the org''s installed modules and their active versions; contributions project into existing tables (page_specs first), the immutable version rows carry what each version declared';

COMMENT ON COLUMN public.modules.key IS
  'Stable slug, unique per org — the module''s identity across installs and upgrades. Lowercase [a-z0-9-], 2-64 chars.';

COMMENT ON COLUMN public.modules.active_version_id IS
  'The version whose contributions are projected right now. NULL only transiently between install and first version activation, or after a full rollback.';

COMMENT ON COLUMN public.modules.granted_permissions IS
  'Permissions the admin granted this module at install. The module runs with (granted ∩ installer''s effective permissions); a subset of the manifest''s requested permissions — an admin may grant fewer.';

-- ---------------------------------------------------------------------------

CREATE TABLE public.module_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    module_id uuid NOT NULL,
    version text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT module_versions_semver CHECK ((version ~ '^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$'::text)),
    CONSTRAINT module_versions_manifest_object CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT module_versions_status_shape CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'superseded'::text, 'rolled_back'::text])))
);

ALTER TABLE public.module_versions
    ADD CONSTRAINT module_versions_pkey PRIMARY KEY (id);

ALTER TABLE public.module_versions
    ADD CONSTRAINT module_versions_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES public.orgs (id)
    ON DELETE CASCADE;

-- The module that owns this version, pinned tenant-coherently: a bare id FK
-- could only prove the uuid exists; the composite edge proves the version and
-- its module belong to the same org, which is the invariant RLS cannot check
-- while the FK is being maintained.
ALTER TABLE public.module_versions
    ADD CONSTRAINT module_versions_module_id_fkey
    FOREIGN KEY (org_id, module_id)
    REFERENCES public.modules (org_id, id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX module_versions_module_version ON public.module_versions USING btree (module_id, version);

CREATE UNIQUE INDEX module_versions_org_id_id_unique ON public.module_versions USING btree (org_id, id);

CREATE INDEX module_versions_org_module ON public.module_versions USING btree (org_id, module_id);

CREATE INDEX module_versions_module_status ON public.module_versions USING btree (module_id, status);

ALTER TABLE public.module_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.module_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON public.module_versions
    AS permissive
    FOR all
    TO PUBLIC
    USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))
    WITH CHECK ((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)));

COMMENT ON TABLE public.module_versions IS
  'openbooks:module_versions:v1 - one immutable row per module version; the manifest a version declared, kept verbatim after supersession so audit evidence and rollback both point at the exact bytes that ran';

COMMENT ON COLUMN public.module_versions.version IS
  'Semver label from the manifest (e.g. 1.0.0, 2.1.0-rc.1). Unique per module.';

COMMENT ON COLUMN public.module_versions.manifest IS
  'The validated manifest this version declared: identity, requested permissions, and its contributions, each naming a contribution kind and the target table it projects into. Immutable once written.';

COMMENT ON COLUMN public.module_versions.status IS
  'Lifecycle: pending (uploaded, not yet approved/applied), active (its contributions are projected), superseded (a newer version is active), rolled_back (its contributions were withdrawn by a rollback).';

-- A module's active version must be one of its own versions, in its own org —
-- the same tenant-coherent composite shape as the down-edge, added now that
-- both tables exist. DEFERRABLE so an installer may insert the module row and
-- its first version in one transaction.
ALTER TABLE public.modules
    ADD CONSTRAINT modules_active_version_id_fkey
    FOREIGN KEY (org_id, active_version_id)
    REFERENCES public.module_versions (org_id, id)
    ON DELETE SET NULL (active_version_id)
    DEFERRABLE NOT VALID;

ALTER TABLE public.modules
    VALIDATE CONSTRAINT modules_active_version_id_fkey;

-- The immutability boundary. The manifest and version label ARE the audit
-- evidence for every approval, projection and rollback this platform records
-- against this row; letting them change in place would retroactively edit
-- what an admin approved. Status transitions and the audit columns remain
-- writable — status is the lifecycle the installer owns, and updated_at/by
-- record who moved it.
CREATE OR REPLACE FUNCTION public.module_version_immutability_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.manifest IS DISTINCT FROM OLD.manifest THEN
    RAISE EXCEPTION 'module version % manifest is immutable; append a new version instead', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'module version label % is immutable; append a new version instead', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.module_id IS DISTINCT FROM OLD.module_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'module version % ownership is immutable', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.module_version_immutability_guard() IS
  'openbooks:module_version_immutability:v1 - a module version''s manifest, label and ownership never change after write; append a new version row instead';

DROP TRIGGER IF EXISTS module_versions_immutability ON public.module_versions;
CREATE TRIGGER module_versions_immutability
  BEFORE UPDATE ON public.module_versions
  FOR EACH ROW EXECUTE FUNCTION public.module_version_immutability_guard();
