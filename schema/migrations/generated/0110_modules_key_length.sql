-- OpenBooks forward migration 0110_modules_key_length.
--
-- Relaxes modules_key_length from 2..64 to 1..64 so the storage boundary
-- accepts exactly what the manifest vocabulary already allows. 0109 performs
-- the same relaxation before its own backfill (a later-only relax would halt
-- an upgrade holding a valid 1-char app at 0109's INSERT); this migration
-- re-asserts the shape — DROP + ADD is definition-agnostic — so every
-- database converges to 1..64 regardless of which 0109 text it ran, then
-- repeats the idempotent backfill to pick up rows an older backfill skipped.
--
-- The canonical key rule lives in the manifests, not here: SLUG
-- (^[a-z][a-z0-9-]*$, 1..64) in web/lib/apps/manifest.ts accepts 1-char
-- keys, and installed apps predate modules — tightening the manifests to
-- match the old 2-char floor would retroactively invalidate apps that are
-- already live. So the DB side relaxes instead: a 1-char app key absorbs
-- onto the modules surface like any other, and the backfill's shape guard
-- is the same SLUG the app manifest enforces (length 1..64 plus the
-- slug-shape match), not a stricter private rule.
--
-- The 0109 backfill skipped sub-2-char keys, so on databases where 0109
-- already ran a 1-char app may still lack its modules row. The three
-- backfill statements are repeated below with the corrected filter —
-- rerunnable by construction (provenance NOT EXISTS plus unique-conflict
-- skips), no-ops for every row 0109 already absorbed. Ongoing absorption
-- (engine absorbAppsForOrg) carries the same corrected filter.

-- The old floor (2..64, from 0107) goes first so the relaxed shape below is
-- the only modules_key_length in the catalog — never two competing checks.
ALTER TABLE public.modules
    DROP CONSTRAINT modules_key_length;

ALTER TABLE public.modules
    ADD CONSTRAINT modules_key_length CHECK (((length(key) >= 1) AND (length(key) <= 64)));

-- Re-backfill with the corrected filter: length 1..64 AND the manifest SLUG
-- shape, the catalogue-filtered permissions with unmapped ones named in
-- provenance, and description omitted when the app has none — the same
-- contract-passing manifest 0109 now writes.
-- shape. Picks up 1-char apps 0109 skipped; changes nothing otherwise.
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

UPDATE public.modules m
   SET active_version_id = mv.id
  FROM public.apps a
  JOIN public.app_versions av ON av.id = a.active_version_id AND av.org_id = a.org_id
  JOIN public.module_versions mv ON mv.version = av.version AND mv.org_id = a.org_id
 WHERE m.app_id = a.id
   AND mv.module_id = m.id
   AND (m.active_version_id IS NULL OR m.active_version_id <> mv.id);

COMMENT ON CONSTRAINT modules_key_length ON public.modules IS
  'openbooks:module-key-vocabulary:v1 - 1..64 chars; the manifest SLUG (web/lib/apps/manifest.ts) owns the key shape, storage only floors length so already-installed 1-char app keys absorb.';
