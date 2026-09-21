-- OpenBooks forward migration 0237_non_gl_depreciation_recognition.
-- Retain recognized reporting-book amounts without inventing GL entries.
-- Existing posted/imported history is unchanged. The timestamp is explicit
-- evidence, not a backfill inferred from today's accounting-book policy.
ALTER TABLE public.depreciation_schedule_lines
  ADD COLUMN IF NOT EXISTS non_gl_recognized_at timestamptz;
ALTER TABLE public.depreciation_schedule_lines
  DROP CONSTRAINT IF EXISTS depr_lines_posting_evidence_pair;
ALTER TABLE public.depreciation_schedule_lines
  ADD CONSTRAINT depr_lines_posting_evidence_pair CHECK (
    (posted_amount IS NULL AND journal_entry_id IS NULL)
    OR (posted_amount IS NOT NULL AND
      (posted_amount = 0 OR journal_entry_id IS NOT NULL OR source = 'imported'
       OR non_gl_recognized_at IS NOT NULL))
  );
ALTER TABLE public.depreciation_schedule_lines
  DROP CONSTRAINT IF EXISTS depr_lines_non_gl_recognition;
ALTER TABLE public.depreciation_schedule_lines
  ADD CONSTRAINT depr_lines_non_gl_recognition CHECK (
    non_gl_recognized_at IS NULL OR
    (posted_amount IS NOT NULL AND journal_entry_id IS NULL AND source <> 'imported')
  );

CREATE OR REPLACE FUNCTION public.depreciation_non_gl_recognition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  book_id uuid;
  subsidiary_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.non_gl_recognized_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'recognized reporting-book depreciation is immutable; retain this line and rebuild only unrecognized schedule lines';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.non_gl_recognized_at IS NULL THEN RETURN NEW; END IF;

  -- A recognition completes an existing measurement, never rewrites a posted
  -- one or launders imported/GL evidence into the reporting-only path.
  IF NEW.posted_amount IS NULL OR NEW.posted_amount IS DISTINCT FROM NEW.planned_amount
     OR NEW.journal_entry_id IS NOT NULL OR NEW.source = 'imported'
     OR (TG_OP = 'UPDATE' AND OLD.posted_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'reporting-book recognition requires its unrecognized planned amount and no GL journal';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - ARRAY['posted_amount','non_gl_recognized_at','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['posted_amount','non_gl_recognized_at','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'recognize the existing depreciation measurement before proposing a separate correction';
  END IF;
  SELECT b.id, a.subsidiary_id INTO book_id, subsidiary_id
    FROM public.depreciation_schedules s
    JOIN public.accounting_books b ON b.id = s.book_id AND b.org_id = s.org_id
    JOIN public.fixed_assets a ON a.id = s.asset_id AND a.org_id = s.org_id
    JOIN public.accounting_periods p ON p.id = NEW.period_id AND p.org_id = s.org_id
   WHERE s.id = NEW.schedule_id AND s.org_id = NEW.org_id
     AND b.is_active AND NOT b.posts_gl
     AND a.status NOT IN ('disposed', 'written_off')
   FOR SHARE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reporting-book recognition requires an active non-posting book and an active asset and period in the same organization';
  END IF;
  IF NEW.updated_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.updated_by AND u.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'depreciation recognition actor must belong to the same organization';
  END IF;
  PERFORM public.period_posting_fence(NEW.org_id, NEW.period_id, book_id);
  IF public.period_module_blocks_write(NEW.org_id, NEW.period_id, book_id, subsidiary_id, 'assets', false)
     OR public.period_module_blocks_write(NEW.org_id, NEW.period_id, book_id, subsidiary_id, 'gl', false) THEN
    RAISE EXCEPTION 'the accounting book is closed for depreciation; obtain an authorized period reopening before running depreciation';
  END IF;
  -- An operator cannot backdate the recognition timestamp used by reversal
  -- guards. The effective service period remains NEW.period_id.
  NEW.non_gl_recognized_at := clock_timestamp();
  NEW.updated_at := NEW.non_gl_recognized_at;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS depreciation_non_gl_recognition_guard ON public.depreciation_schedule_lines;
CREATE TRIGGER depreciation_non_gl_recognition_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.depreciation_schedule_lines
FOR EACH ROW EXECUTE FUNCTION public.depreciation_non_gl_recognition_guard();

CREATE OR REPLACE FUNCTION public.depreciation_non_gl_recognition_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.non_gl_recognized_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.non_gl_recognized_at IS NULL) THEN
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
    VALUES (NEW.org_id, 'depreciation_schedule_lines', NEW.id, lower(TG_OP),
      jsonb_build_object(
        'before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        'after', to_jsonb(NEW),
        'reason', 'Recognize reporting-book depreciation without a GL journal'),
      NEW.updated_by);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS depreciation_non_gl_recognition_audit ON public.depreciation_schedule_lines;
CREATE TRIGGER depreciation_non_gl_recognition_audit
AFTER INSERT OR UPDATE ON public.depreciation_schedule_lines
FOR EACH ROW EXECUTE FUNCTION public.depreciation_non_gl_recognition_audit();
