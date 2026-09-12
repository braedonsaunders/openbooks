-- OpenBooks forward migration 0108_module_contributions.
--
-- The seam through which page_specs becomes a module projection target.
--
-- A module version declares contributions; a page contribution projects into
-- page_specs, which already proves the pattern end to end (0104-0106): the
-- renderer resolves one active spec per route, an install writes that row, a
-- rollback deactivates it. What page_specs rows have lacked until now is the
-- answer to "which module version put this here" — which is exactly what a
-- rollback needs to withdraw the right rows, what the audit trail needs to
-- name, and what an admin needs to see standing behind a page they did not
-- author themselves.
--
-- module_version_id is deliberately NULLABLE with no NOT NULL and no default:
-- every page_specs row written by the existing authoring paths — a tenant
-- layout saved from the admin screen, a restore, an agent publish — keeps
-- meaning precisely what it meant before this migration ran. Only rows a
-- module installer writes carry the pointer.
--
-- The FK is the composite tenant-coherent shape (org_id, module_version_id)
-- → module_versions (org_id, id), with ON DELETE RESTRICT: deleting a module
-- version that still has projected page_specs would orphan the layout a
-- running page renders from. Uninstall/rollback deactivates projection rows
-- first (the installer's job); RESTRICT is what makes skipping that order a
-- storage error rather than a silent orphan. Single-column FKs prove only
-- that the uuid exists; the composite edge proves the projection and the
-- module version belong to the same org, an invariant RLS cannot check while
-- the FK is maintained.

ALTER TABLE public.page_specs
    ADD COLUMN module_version_id uuid;

ALTER TABLE public.page_specs
    ADD CONSTRAINT page_specs_module_version_id_fkey
    FOREIGN KEY (org_id, module_version_id)
    REFERENCES public.module_versions (org_id, id)
    ON DELETE RESTRICT
    DEFERRABLE NOT VALID;

ALTER TABLE public.page_specs
    VALIDATE CONSTRAINT page_specs_module_version_id_fkey;

-- The provenance lookup: which module version projected a given row.
CREATE INDEX page_specs_module_version ON public.page_specs
    USING btree (org_id, module_version_id) WHERE (module_version_id IS NOT NULL);

COMMENT ON COLUMN public.page_specs.module_version_id IS
  'The module version whose page contribution projected this row, or NULL for a tenant-authored layout saved through the ordinary admin paths. Set only by the module installer; the composite FK pins it to this org.';
