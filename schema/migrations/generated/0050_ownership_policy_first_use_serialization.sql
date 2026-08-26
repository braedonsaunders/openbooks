-- OpenBooks forward migration 0050_ownership_policy_first_use_serialization.
--
-- ownership_interest_guard freezes a policy row only once COMMITTED evidence
-- exists, and the FK from ownership_consolidation_entries takes just FOR KEY
-- SHARE — which a material (non-key) policy UPDATE does not conflict with. A
-- first-use consolidation therefore used to read the policy, compute, and
-- insert its evidence while a concurrent material edit committed new terms in
-- between: posted journals calculated from the old policy beside a live row
-- recording new terms.
--
-- The evidence insert now takes an explicit FOR SHARE on the policy row at
-- the storage boundary (the same shape as jl_check_account): every evidence
-- writer holds the row lock a material policy UPDATE must own until its
-- transaction ends, so the editor either waits and then faces the guard's
-- immutability check against the now-committed evidence, or fails its own
-- serialization. The engine additionally reads the effective policy FOR
-- SHARE before computing a generation, pinning the terms for the whole run.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.ownership_evidence_policy_fence() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
BEGIN
  PERFORM 1
    FROM public.subsidiary_ownership_interests policy
   WHERE policy.id = NEW.interest_id
     AND policy.org_id = NEW.org_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ownership evidence must reference a policy of the same organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.ownership_evidence_policy_fence() IS
  'openbooks:ownership_evidence_policy_fence:v1 - holds a FOR SHARE lock on the ownership policy from the first evidence insert so material policy edits serialize with first-use consolidation';

DROP TRIGGER IF EXISTS ownership_evidence_policy_fence ON public.ownership_consolidation_entries;
CREATE TRIGGER ownership_evidence_policy_fence
  BEFORE INSERT ON public.ownership_consolidation_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.ownership_evidence_policy_fence();

COMMENT ON TRIGGER ownership_evidence_policy_fence ON public.ownership_consolidation_entries IS
  'openbooks:ownership_evidence_policy_fence:v1 - serializes ownership evidence insertion with material policy edits';
