-- OpenBooks forward migration 0241_hrm_party_reference_integrity.
--
-- Eleven HRM columns name a party and nothing made them point at one.
--
-- HR-6's 0195 established the form: every party reference is
-- FOREIGN KEY (org_id, <col>) REFERENCES parties(org_id, id) DEFERRABLE.
-- The pair is deliberate. A plain REFERENCES parties(id) would let a row
-- in one organization cite a party in ANOTHER, because the id alone
-- carries no tenant; the composite key makes that unrepresentable rather
-- than merely discouraged. It is the same cross-tenant-reference class
-- the sandbox clones were bitten by.
--
-- Three later shards declared their party columns with no constraint at
-- all: 0221 (compensation), 0228 (continuous performance) and 0230
-- (documents and surveys). Nothing failed, because nothing checks a
-- column that has no constraint. What surfaced it was the party-merge
-- coverage test, which compares the live foreign-key catalogue against
-- PARTY_MERGE_REF_COVERAGE: the coverage list already names all eleven,
-- so the merge path was written expecting constraints the database never
-- had.
--
-- That is the operational cost. Merging two duplicate parties re-points
-- every covered reference and then deletes the loser; these eleven were
-- invisible to that walk, so a merge would have left a feedback author,
-- a 1:1 assignee or a DSAR SUBJECT pointing at a party that no longer
-- exists. A data-subject export naming a deleted or foreign party is the
-- worst place in the product for this to land.
--
-- DEFERRABLE matches 0195 and matters: the HRM writers insert a parent
-- and its children inside one transaction, and several seed paths write
-- children before the party row settles.
--
-- Every one of the eleven tables carries org_id, so all eleven take the
-- composite form with no exceptions and no nullable-tenant special case.
-- The columns themselves are left exactly as they are -- nullable stays
-- nullable -- because this migration adds referential integrity, not a
-- new requirement to supply a party.

-- 0221: the department or manager a comp budget is allocated to.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_manager_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_manager_party_tenant_fkey
    FOREIGN KEY (org_id, manager_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0221: who approved or rejected a proposed comp change.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_approver_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_approver_party_tenant_fkey
    FOREIGN KEY (org_id, approver_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0228: who runs a calibration session.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_calibration_sessions_facilitator_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_calibration_sessions ADD CONSTRAINT hrm_calibration_sessions_facilitator_party_tenant_fkey
    FOREIGN KEY (org_id, facilitator_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0228: who wrote a piece of feedback.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_feedback_author_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_feedback ADD CONSTRAINT hrm_feedback_author_party_tenant_fkey
    FOREIGN KEY (org_id, author_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0228: who feedback was requested from.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_feedback_requested_from_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_feedback ADD CONSTRAINT hrm_feedback_requested_from_party_tenant_fkey
    FOREIGN KEY (org_id, requested_from_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0228: who wrote a 1:1 item.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_one_on_one_items_author_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_one_on_one_items ADD CONSTRAINT hrm_one_on_one_items_author_party_tenant_fkey
    FOREIGN KEY (org_id, author_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0228: who a 1:1 action item is assigned to.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_one_on_one_items_assignee_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_one_on_one_items ADD CONSTRAINT hrm_one_on_one_items_assignee_party_tenant_fkey
    FOREIGN KEY (org_id, assignee_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0230: the person a personnel document is about.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_documents ADD CONSTRAINT hrm_documents_party_tenant_fkey
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0230: who is asked to sign a document.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_signer_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_document_signers ADD CONSTRAINT hrm_document_signers_signer_party_tenant_fkey
    FOREIGN KEY (org_id, signer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0230: the subject of a data-subject access request.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_data_subject_exports_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_data_subject_exports ADD CONSTRAINT hrm_data_subject_exports_party_tenant_fkey
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

-- 0230: who an engagement survey was sent to.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_invitations_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_survey_invitations ADD CONSTRAINT hrm_survey_invitations_party_tenant_fkey
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
