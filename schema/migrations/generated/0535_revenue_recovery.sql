-- Revenue recovery: decline-class retry ladders, authentication links, backup
-- method fallback, card account updater state and pre-expiry outreach.
--
-- The retry schedule stays on the dunning policy next to the existing soft
-- ladder: insufficient-funds retries land near typical paydays instead of on
-- the generic cadence, hard declines wait for new payment details, and
-- authentication-required attempts keep the customer-facing link. Attempts
-- record which backup method recovered them; methods record updater refresh
-- state and whether pre-expiry outreach already went out. All columns are
-- additive with safe defaults and no existing row is read or rewritten.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Per-class retry configuration on the collection policy: the
-- insufficient-funds ladder defaults to payday-adjacent offsets (3, 7 and 14
-- days out catch mid-month and end-of-month pay runs), and the pre-expiry
-- notice window defaults to 30 days. Bounds are enforced by the engine
-- exactly as for the existing soft ladder.
ALTER TABLE public.dunning_policies
 ADD COLUMN autopay_insufficient_funds_offsets_days integer[] NOT NULL DEFAULT '{3,7,14}',
 ADD COLUMN autopay_expiry_notice_days integer NOT NULL DEFAULT 30;
ALTER TABLE public.dunning_policies
 ADD CONSTRAINT dunning_policies_autopay_expiry_notice_days_chk CHECK ((autopay_expiry_notice_days BETWEEN 1 AND 90));

-- The decline taxonomy grows from hard/soft to four classes: hard (wait for
-- new payment details), soft (generic cadence), insufficient_funds
-- (payday-adjacent cadence) and needs_authentication (customer action, never
-- an automatic retry). The check is widened, never narrowed: every stored
-- value stays valid.
ALTER TABLE public.collection_attempts DROP CONSTRAINT collection_attempts_decline_kind_chk;
ALTER TABLE public.collection_attempts
 ADD CONSTRAINT collection_attempts_decline_kind_chk CHECK ((decline_kind IS NULL OR decline_kind = ANY (ARRAY['hard'::text, 'soft'::text, 'insufficient_funds'::text, 'needs_authentication'::text])));
-- Authentication-required attempts keep the customer-facing verification
-- link; fallback charges record the failed method that triggered them, so
-- recovery reporting can tell primary from backup collections.
ALTER TABLE public.collection_attempts
 ADD COLUMN auth_url text,
 ADD COLUMN fallback_method_id uuid REFERENCES public.customer_payment_methods(id);

-- Ordered backup methods (lower fallback_priority is tried first after the
-- default), the last card-updater refresh, and the date pre-expiry outreach
-- last went out (cleared whenever the updater moves the expiry).
ALTER TABLE public.customer_payment_methods
 ADD COLUMN fallback_priority integer NOT NULL DEFAULT 0,
 ADD COLUMN last_updater_refresh_at timestamptz,
 ADD COLUMN expiry_notified_on date;
