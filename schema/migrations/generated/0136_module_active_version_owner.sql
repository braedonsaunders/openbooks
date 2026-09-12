-- OpenBooks forward migration 0136_module_active_version_owner.
--
-- The active version must belong to this module, not merely to its organization.
-- Keep the existing tenant foreign key; this adds the missing ownership edge
-- without changing tenant rows or rewriting any historical migration.
CREATE UNIQUE INDEX module_versions_org_module_id_unique
  ON public.module_versions (org_id, module_id, id);

ALTER TABLE public.modules
  ADD CONSTRAINT modules_active_version_owner_fkey
  FOREIGN KEY (org_id, id, active_version_id)
  REFERENCES public.module_versions (org_id, module_id, id)
  ON DELETE SET NULL (active_version_id)
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.modules VALIDATE CONSTRAINT modules_active_version_owner_fkey;

COMMENT ON CONSTRAINT modules_active_version_owner_fkey ON public.modules IS
  'An active version is owned by this exact module and organization; another module in the same tenant cannot supply its manifest.';
