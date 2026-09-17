-- OpenBooks forward migration 0171_expense_line_settlement_type.
--
-- An expense report line can be settled three different ways and they are
-- three different pieces of accounting: out-of-pocket (the employee fronted
-- the money; the company owes a person), company-paid corporate card (the
-- company already paid via the card issuer; the employee is owed nothing),
-- and personal-on-corporate-card (not an expense at all; the employee owes
-- the company). Until now the posting rule credited every report to a single
-- employee-payable control, so a company-paid line manufactured a phantom
-- employee payable and a personal line hid inside the expense.
--
-- WHY NULLABLE, AND WHAT NULL MEANS. The production tenant observed while
-- designing this holds 9,068 posted expense reports whose columns do not record intent:
-- 8,663 route via control override to per-employee card-liability accounts, a
-- pattern consistent with company-paid funding but indistinguishable from an
-- out-of-pocket payable parked on a card-typed account. Backfilling
-- out_of_pocket would assert a fact about 8,663 documents that nobody has, and
-- the next reader would not know it was a guess; backfilling company_paid
-- would be worse (it requires a card instrument, of which zero exist, so
-- regeneration of those reports would fail closed). So history stays honestly
-- unclassified: settlement_type is NULLABLE, NULL means "settlement not
-- recorded", and the repost path treats NULL exactly as out_of_pocket — the
-- legacy math — keeping regeneration byte-identical. New expense-report lines
-- must carry an explicit value (enforced at the edit API, not here: drafts
-- legitimately pass through incomplete states, and other document kinds never
-- read this column).
--
-- RECLASSIFYING HISTORY. Posted entries are immutable; nothing here rewrites
-- them. A tenant that ran the per-employee-card convention classifies itself
-- going forward by creating one payment_cards row per cardholder account and
-- naming the card on new reports — a suggested setup step for the operator,
-- deliberately NOT seeded here (a schema migration must not invent tenant
-- records). Correcting a posted report already re-posts through the normal
-- correction draft, where the clerk can set the settlement explicitly.
--
-- The card itself stays header-level (documents.payment_card_id, one card per
-- report — the honest common case). A per-line card override was deliberately
-- deferred, not overlooked: nothing here forbids adding it later, and a
-- speculative column for a case nobody has seen would be structure without a
-- customer. Mixed-card spending files as separate reports until then.
--
-- Forward-only: narrowing back to a single settlement would strand reports
-- that already distinguish card and personal lines, and reinterpreting NULL
-- as anything but legacy math would rewrite history by accident.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.document_lines
  ADD COLUMN IF NOT EXISTS settlement_type text;

ALTER TABLE public.document_lines DROP CONSTRAINT IF EXISTS document_lines_settlement_type;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_settlement_type
  CHECK (settlement_type in ('out_of_pocket', 'company_paid', 'personal'));

COMMENT ON COLUMN public.document_lines.settlement_type IS
  'Who fronted the money for this expense line (0171): out_of_pocket = employee paid, company owes a person; company_paid = company-liability card, company owes the issuer; personal = non-business charge on the company card, employee owes the company (receivable, never an expense). NULL = settlement not recorded (all pre-0171 history); the repost path treats NULL as out_of_pocket legacy math';

COMMENT ON COLUMN public.documents.payment_card_id IS
  'Funding card: the card_charge/refund instrument, or the single corporate card backing the company_paid and personal lines of an expense_report (0171: one card per report; per-line override deliberately deferred)';
