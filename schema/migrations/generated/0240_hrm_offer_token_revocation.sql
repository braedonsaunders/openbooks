-- OpenBooks forward migration 0240_hrm_offer_token_revocation.
--
-- HR-18 follow-up, found in security review: an offer signing link was
-- never revocable.
--
-- THE HOLE. sendOfferLink minted an HMAC token binding the offer id and
-- an expiry, emailed it, and stored NOTHING. offerScopeForToken verified
-- the signature and then looked the offer up by the id inside the token.
-- Two consequences, both live:
--
--   Every token ever minted for an offer stayed valid for its full
--   30-day life. Re-sending an offer -- because the candidate lost the
--   email, because the terms were re-rendered, because the wrong person
--   was mailed -- added a second working link instead of replacing the
--   first. There was no way to take a signing link back.
--
--   A link forwarded, quoted in a reply chain, or sitting in a mailbox
--   someone else later reads kept working, and nothing in the product
--   could stop it short of voiding the offer.
--
-- Booking already does this correctly: hrm_interview_slots carries
-- candidate_token_hash, the route looks the slot up BY HASH, and
-- rescheduling overwrites the hash, which invalidates the old link as a
-- side effect of the write that replaced it. This migration gives
-- offers the same column so signing can follow the same rule.
--
--   signing_token_hash — SHA-256 hex of the raw token. The raw token is
--   emailed once and never stored, so a database reader cannot mint a
--   signing link, and a leaked backup does not carry live links. NULL
--   means no link is outstanding: an offer that has never been sent, or
--   one whose signature closed.
--
-- The column is nullable and additive. Offers already sent under the old
-- code have no stored hash; their links stop working at the next send,
-- which is the correct direction for a revocation fix -- a link nobody
-- can revoke is not a link worth honouring.

ALTER TABLE ONLY public.hrm_offers
  ADD COLUMN IF NOT EXISTS signing_token_hash text;

-- The lookup the scope check makes on every sessionless signing request.
-- Partial: only outstanding links are ever looked up by hash.
CREATE INDEX IF NOT EXISTS hrm_offers_signing_token
  ON public.hrm_offers USING btree (org_id, signing_token_hash)
  WHERE signing_token_hash IS NOT NULL;

-- A duplicate apply must not be distinguishable from a first apply on a
-- public form (it would answer "is this email in your pipeline?"), so
-- the attempt is recorded for staff in the posting ledger instead of
-- being told to the applicant.
ALTER TABLE ONLY public.hrm_posting_events
  DROP CONSTRAINT IF EXISTS hrm_posting_events_kind;
ALTER TABLE ONLY public.hrm_posting_events
  ADD CONSTRAINT hrm_posting_events_kind
    CHECK (kind IN ('published', 'paused', 'closed', 'apply_received',
                    'apply_duplicate', 'disposition_sent', 'error'));
