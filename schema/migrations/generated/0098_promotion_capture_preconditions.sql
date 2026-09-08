-- OpenBooks forward migration 0098_promotion_capture_preconditions.
-- Preserve the production state reviewed by each configuration promotion.
-- Existing artifacts remain untouched and explicitly lack a captured base;
-- they must be recaptured before application by the new engine.
ALTER TABLE public.change_set_items
  ADD COLUMN expected_before jsonb,
  ADD COLUMN base_captured boolean NOT NULL DEFAULT false;

ALTER TABLE public.change_set_items
  ADD CONSTRAINT change_set_items_captured_base_valid CHECK (
    NOT base_captured OR coalesce(
      (op = 'insert' AND expected_before IS NULL) OR
      (op IN ('update', 'delete') AND expected_before IS NOT NULL
        AND jsonb_typeof(expected_before) = 'object'
        AND expected_before->>'id' = target_id::text
        AND expected_before->>'org_id' = org_id::text),
      false
    )
  );
SELECT public.openbooks_refresh_query_catalog();
