-- OpenBooks forward migration 0109_absorb_apps.
--
-- Every installed app gets a modules row and an active module version, so the
-- modules table becomes the lifecycle/audit surface for apps too — while the
-- apps runtime keeps serving exactly what it serves today.
--
-- What changes, and what deliberately does not:
--
--   modules gains two columns. `kind` ('module' for installer-created rows,
--   'app' for absorbed rows) names which runtime owns the package; `app_id`
--   is the provenance edge back to the absorbed app, pinned
--   tenant-coherently as (org_id, app_id) → apps (org_id, id) — a bare id FK
--   could only prove the uuid exists, while the composite edge proves the
--   module row and its app belong to the same org, the invariant RLS cannot
--   check while the FK is being maintained (the same shape 0107 uses for
--   module_versions → modules). apps publishes (org_id, id) explicitly for
--   exactly this edge. The edge is ON DELETE CASCADE: deleteApp removes the
--   apps row while its versions/files cascade with it, and the absorbed
--   lifecycle row must vanish with its app rather than dangle — uninstall
--   evidence stays in audit_log, where deleteApp already snapshots the whole
--   bundle (versions, files, runs, storage) verbatim.
--
--   The backfill inserts one modules row per apps row (presentation, grants
--   and status copied verbatim — 'installed'/'disabled' is the same
--   vocabulary on both tables) and one module_versions row per absorbed app
--   that has an active app version. The version manifest is PROJECTED from
--   the active app bundle manifest — identity, the requested permissions
--   the module contract accepts, and a provenance object (kind 'app',
--   appId/appKey/appVersionId, plus unmappedPermissions naming every
--   requested permission the contract has no member for: an app manifest
--   accepts any string, the module contract only its catalogue, and the
--   narrowing is recorded, never silent) — with an empty contributions
--   list: an app's bundle files stay in app_files and are
--   referenced by app_id, never duplicated into module storage, and nothing
--   projects into page_specs or any other module target. The manifest is
--   shaped so it passes the module contract validator: description is
--   omitted when the app has none (absent and empty differ; a null would
--   fail the contract's optional string). The row's granted_permissions
--   keep the admin's actual grants verbatim — that column is the grant
--   record, not the request record. The version status
--   is 'active' and modules.active_version_id is linked, because the app is
--   live; a future uninstall/deactivation flows through the same lifecycle
--   transitions native modules use.
--
--   Apps without an active version (the transient between create and first
--   publish) still get their modules row, with active_version_id left NULL —
--   the same transient 0107 allows between install and first activation.
--
--   No audit_log rows are written here. The app's own install audit evidence
--   already records the grant decision with before/after; the backfill makes
--   no new decision, it only registers the existing one on the modules
--   surface. Steady-state maintenance lives in installApp
--   (web/lib/apps/store.ts), which mirrors the module row and version
--   inline in the same transaction as the apps writes; absorbAppsForOrg in
--   engine/src/modules/absorb-apps.ts is the idempotent repair path for
--   rows that predate that wiring or were missed, so this migration only
--   ever has to cover rows that predate it. Every statement below is rerunnable (NOT EXISTS guards plus
--   ON CONFLICT DO NOTHING) so a retry never double-absorbs.
--
--   The shape guard mirrors the manifest SLUG exactly (1..64 plus the
--   slug-shape match, owned by web/lib/apps/manifest.ts): storage floors
--   length and shape so the backfill can never write a row the relaxed
--   modules_key_length CHECK (0110) would refuse. App keys outside that
--   shape predate even manifest validation and stay out, loudly visible
--   as apps rows with no absorbing module row.

-- PostgreSQL requires an exact unique key for each composite foreign key, so
-- apps publishes (org_id, id) explicitly — the same reason 0107 publishes
-- modules_org_id_id_unique. Implied by the primary key; the index only names
-- it for the FK below.
CREATE UNIQUE INDEX apps_org_id_id_unique ON public.apps USING btree (org_id, id);

-- The discriminator: installer-owned modules are 'module', absorbed apps are
-- 'app'. Defaults so every pre-existing (installer-written) row reads as a
-- native module without a data rewrite.
ALTER TABLE public.modules
    ADD COLUMN kind text DEFAULT 'module'::text NOT NULL;

ALTER TABLE public.modules
    ADD CONSTRAINT modules_kind_shape CHECK ((kind = ANY (ARRAY['module'::text, 'app'::text])));

-- The provenance edge: which app this module row absorbs. NULL for native
-- modules. Partial uniqueness: at most one module row absorbs a given app.
ALTER TABLE public.modules
    ADD COLUMN app_id uuid;

CREATE UNIQUE INDEX modules_app_id_unique ON public.modules USING btree (app_id) WHERE (app_id IS NOT NULL);

-- The key vocabulary relaxes HERE, before the backfill — not in a later
-- migration. The manifest SLUG (^[a-z][a-z0-9-]*$, 1..64, owned by
-- web/lib/apps/manifest.ts) admits 1-char keys, so the backfill below
-- legitimately inserts 1-char module rows; relaxing only in 0110 would
-- halt an upgrade containing a valid 1-char app at this migration's
-- INSERT (the 0107 2-char floor). 0110 re-asserts the same shape so any
-- database converges regardless of which 0109 text it ran.
ALTER TABLE public.modules
    DROP CONSTRAINT modules_key_length;

ALTER TABLE public.modules
    ADD CONSTRAINT modules_key_length CHECK (((length(key) >= 1) AND (length(key) <= 64)));

-- Backfill, part 1: one modules row per installed app. Presentation, grants
-- and status are copied verbatim; the apps runtime keeps owning them.
INSERT INTO public.modules
  (org_id, key, name, description, icon_key, status, granted_permissions, kind, app_id,
   created_at, created_by, updated_at, updated_by)
SELECT a.org_id, a.key, a.name, a.description, a.icon_key, a.status, a.granted_permissions,
       'app', a.id, a.created_at, a.created_by, a.updated_at, a.updated_by
  FROM public.apps a
 WHERE NOT EXISTS (SELECT 1 FROM public.modules m WHERE m.app_id = a.id)
   AND length(a.key) BETWEEN 1 AND 64
   AND a.key ~ '^[a-z][a-z0-9-]*$'
ON CONFLICT (org_id, key) DO NOTHING;

-- Backfill, part 2: one ACTIVE module version per absorbed app, its manifest
-- projected from the active app bundle manifest. Requested permissions are
-- filtered to the module catalogue (the mirror below, owned by
-- MODULE_PLATFORM_PERMISSIONS in web/lib/modules/manifest.ts); dropped
-- permissions are named in provenance.unmappedPermissions, never silently
-- lost. Description is omitted when the app has none. The row's
-- granted_permissions (part 1) keep the admin's grants verbatim. Bundle
-- files are NOT copied: they stay in app_files under their app_id.
INSERT INTO public.module_versions
  (org_id, module_id, version, manifest, status, created_at, created_by, updated_at, updated_by)
SELECT a.org_id, m.id, av.version,
       jsonb_build_object(
         'key', a.key,
         'name', a.name,
         'version', av.version,
         'permissions', perms.mapped,
         'contributions', '[]'::jsonb,
         'provenance', jsonb_build_object(
           'kind', 'app',
           'appId', a.id,
           'appKey', a.key,
           'appVersionId', av.id,
           'unmappedPermissions', perms.unmapped
         )
       ) || CASE WHEN a.description IS NOT NULL
                  THEN jsonb_build_object('description', a.description)
                  ELSE '{}'::jsonb END,
       'active', av.created_at, av.created_by, av.updated_at, av.updated_by
  FROM public.apps a
  JOIN public.modules m ON m.app_id = a.id
  JOIN public.app_versions av ON av.id = a.active_version_id AND av.org_id = a.org_id
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(e #>> '{}' ORDER BY o) FILTER (WHERE (e #>> '{}') = ANY (ARRAY['ap.create','ap.pay','ap.post','ap.read','ar.create','ar.post','ar.read','assets.manage','assets.read','gl.post','gl.read','items.manage','items.read','parties.manage','parties.read','projects.manage','projects.read','records.create','records.read'])), '[]'::jsonb) AS mapped,
           coalesce(jsonb_agg(e #>> '{}' ORDER BY o) FILTER (WHERE NOT ((e #>> '{}') = ANY (ARRAY['ap.create','ap.pay','ap.post','ap.read','ar.create','ar.post','ar.read','assets.manage','assets.read','gl.post','gl.read','items.manage','items.read','parties.manage','parties.read','projects.manage','projects.read','records.create','records.read']))), '[]'::jsonb) AS unmapped
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(av.manifest -> 'permissions') = 'array'
                                     THEN av.manifest -> 'permissions'
                                     ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
     WHERE jsonb_typeof(t.e) = 'string'
  ) AS perms
 WHERE a.active_version_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.module_versions mv WHERE mv.module_id = m.id AND mv.version = av.version)
ON CONFLICT (module_id, version) DO NOTHING;

-- Backfill, part 3: link each absorbed row to its active version (the
-- DEFERRABLE up-edge from 0107 tolerates either order; the join order here
-- needs no deferral because the version rows already exist).
UPDATE public.modules m
   SET active_version_id = mv.id
  FROM public.apps a
  JOIN public.app_versions av ON av.id = a.active_version_id AND av.org_id = a.org_id
  JOIN public.module_versions mv ON mv.version = av.version AND mv.org_id = a.org_id
 WHERE m.app_id = a.id
   AND mv.module_id = m.id
   AND (m.active_version_id IS NULL OR m.active_version_id <> mv.id);

-- The tenant-coherent provenance edge, validated after the backfill so the
-- scan covers the rows just written. NOT VALID keeps the ADD instantaneous;
-- VALIDATE then proves every absorbed row points inside its own org.
ALTER TABLE public.modules
    ADD CONSTRAINT modules_app_id_fkey
    FOREIGN KEY (org_id, app_id)
    REFERENCES public.apps (org_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.modules
    VALIDATE CONSTRAINT modules_app_id_fkey;

COMMENT ON COLUMN public.modules.kind IS
  'Which runtime owns the package: module (installer-created) or app (absorbed from apps by 0109; the apps runtime still serves it).';

COMMENT ON COLUMN public.modules.app_id IS
  'The absorbed app this module row is the lifecycle surface for, or NULL for a native module. Bundle files stay in app_files under this id — never duplicated. Deleted with the app (ON DELETE CASCADE); uninstall evidence lives in audit_log.';

COMMENT ON CONSTRAINT modules_app_id_fkey ON public.modules IS
  'openbooks:absorbed-app-provenance:v1 - an absorbed module row and its app belong to the same org; the composite edge proves it where RLS cannot.';
