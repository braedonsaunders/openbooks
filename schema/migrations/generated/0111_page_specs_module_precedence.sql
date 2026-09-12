-- OpenBooks forward migration 0111_page_specs_module_precedence.
--
-- Two active rows per route are now legal, on purpose.
--
-- 0106 assumed one active occupant per route per org layer: a single partial
-- unique index over active user-null rows. That held while every row in the
-- table was tenant-authored. Module page contributions (0108) project into
-- this same table, and a tenant customization must SHADOW a module projection
-- by precedence — never by deactivating it (deactivation is the installer's
-- lifecycle to own) and never by failing against it. Shadowing needs the two
-- rows to coexist while both are active, which the 0106 index forbids: a
-- tenant saving over an installed page would either violate the index or
-- destroy the installer's projection, and a tenant clearing could never fall
-- back to the module. So the single org-layer index is replaced by a pair
-- that knows about provenance:
--
--   org-native  — UNIQUE (org_id, route) WHERE active, user-null,
--                 module-null. Still exactly one tenant occupant per route.
--   module      — UNIQUE (org_id, route, module_version_id) WHERE active and
--                 projected. One live row per module version per route, so an
--                 upgrade's new projection never collides with the version it
--                 supersedes and two modules cannot both speak for one route
--                 from the same version.
--
-- The user-scoped index is untouched: a personal layout never shared the org
-- layer and still does not.
--
-- Resolution (web/lib/page-specs.ts, read-time, double-validated) orders the
-- coexisting rows user > org-native > module > built-in, preferring among
-- module rows the one behind its module's active_version_id. A superseded
-- version's row may still be active; it loses to the current projection but
-- still beats built-in, which is what "the module is installed" means even
-- mid-upgrade.
--
-- Safe to apply anywhere 0108 holds: every row satisfying either new
-- predicate also satisfied the old single predicate, so no existing database
-- can violate the new indexes.

DROP INDEX IF EXISTS public.page_specs_active_org_route;

CREATE UNIQUE INDEX page_specs_active_org_native_route ON public.page_specs
    USING btree (org_id, route) WHERE (is_active AND user_id IS NULL AND module_version_id IS NULL);

CREATE UNIQUE INDEX page_specs_active_module_route ON public.page_specs
    USING btree (org_id, route, module_version_id) WHERE (is_active AND module_version_id IS NOT NULL);
