-- OpenBooks forward migration 0140_extension_draft_author_identity.
-- Attribution references the authenticated identity, which can be a platform
-- administrator acting in another organization. Match apps/app_versions:
-- tenant ownership remains org_id with RLS; draft reads and transitions also
-- require the exact created_by identity through the application boundary.
ALTER TABLE public.extension_drafts
  DROP CONSTRAINT extension_drafts_org_id_created_by_fkey,
  ADD CONSTRAINT extension_drafts_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;
