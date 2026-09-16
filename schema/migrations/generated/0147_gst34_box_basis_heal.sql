-- OpenBooks forward migration 0147_gst34_box_basis_heal.
--
-- The first GST34 seed (ba43ab620) installed lines 103 (GST/HST collected)
-- and 106 (input tax credits) with basis 'tax_amount' — "every tax line for
-- the code", with no collected/paid split. A tax code that applies to both
-- sales and purchases was therefore fed whole into BOTH boxes, so 106 came
-- out negated and net tax (line 109) doubled. The split fix (4856a1a3f)
-- corrected the library pack and the computation to the 'tax_collected' /
-- 'tax_paid' bases, but nothing healed the rows already installed: any form
-- installed from the pre-split seed keeps filing the doubled return until
-- someone manually resets the pack to library defaults.
--
-- This migration heals exactly that stale-installed shape, in every org: a
-- CA_GST34 line 103 still on 'tax_amount' moves to 'tax_collected', and a
-- line 106 still on 'tax_amount' moves to 'tax_paid' — the corrected library
-- definition of those two boxes. Only coded rows (tax_code_id is not null)
-- change behavior; manual, formula, and already-correct rows are untouched,
-- as are all other forms. No ledger, document, or posted history is
-- modified: this only changes which side-filtered sum two return boxes read.
--
-- Line 101 (total sales) has the same stale-install root cause in the other
-- direction, with a wider window: the pre-split seed installed it as a MANUAL
-- box (no tax code, no basis — it files 0.0000 unless the filer hand-types
-- it), while the library pack since computes it as the 'taxable_base' over
-- the sales-side codes. Any CA_GST34 install whose 101 is still exactly that
-- manual shape (a null-code, formula-free row and no coded 101 rows at all)
-- gains the library mapping below: one 'taxable_base' row per sales code
-- already mapped on that org's line 103 — the install-time sales set —
-- inheriting the manual row's label/sign/sequence so tenant customizations
-- survive, after which the now-inert manual row is removed so the healed
-- shape equals a fresh library install. Orgs whose 101 is already mapped,
-- customized into a formula, or whose 103 has no sales mapping are untouched.
--
-- Deterministic and idempotent: a re-run matches no rows, because healed
-- rows no longer carry basis 'tax_amount' and healed orgs own coded 101 rows.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

UPDATE public.tax_report_lines
   SET basis = CASE line_code WHEN '103' THEN 'tax_collected' WHEN '106' THEN 'tax_paid' END
 WHERE report_code = 'CA_GST34'
   AND line_code IN ('103', '106')
   AND basis = 'tax_amount'
   AND tax_code_id IS NOT NULL;

WITH stale_101 AS (
  SELECT DISTINCT l103.org_id
    FROM public.tax_report_lines l103
   WHERE l103.report_code = 'CA_GST34'
     AND l103.line_code = '103'
     AND l103.tax_code_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.tax_report_lines m
        WHERE m.org_id = l103.org_id
          AND m.report_code = 'CA_GST34'
          AND m.line_code = '101'
          AND m.tax_code_id IS NULL
          AND (m.formula IS NULL OR m.formula = '')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tax_report_lines c
        WHERE c.org_id = l103.org_id
          AND c.report_code = 'CA_GST34'
          AND c.line_code = '101'
          AND c.tax_code_id IS NOT NULL
     )
),
manual AS (
  SELECT DISTINCT ON (m.org_id) m.org_id, m.label, m.sign, m.sequence
    FROM public.tax_report_lines m
    JOIN stale_101 s ON s.org_id = m.org_id
   WHERE m.report_code = 'CA_GST34'
     AND m.line_code = '101'
     AND m.tax_code_id IS NULL
     AND (m.formula IS NULL OR m.formula = '')
   ORDER BY m.org_id, m.sequence, m.id
),
inserted AS (
  INSERT INTO public.tax_report_lines
    (org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence, formula)
  SELECT DISTINCT l103.org_id, 'CA_GST34', '101',
         COALESCE(manual.label, 'Sales and other revenue'),
         l103.tax_code_id, 'taxable_base',
         COALESCE(manual.sign, 1), COALESCE(manual.sequence, 10), NULL
    FROM public.tax_report_lines l103
    JOIN stale_101 s ON s.org_id = l103.org_id
    LEFT JOIN manual ON manual.org_id = l103.org_id
   WHERE l103.report_code = 'CA_GST34'
     AND l103.line_code = '103'
     AND l103.tax_code_id IS NOT NULL
  RETURNING org_id
)
DELETE FROM public.tax_report_lines m
 USING stale_101 s
 WHERE m.org_id = s.org_id
   AND m.report_code = 'CA_GST34'
   AND m.line_code = '101'
   AND m.tax_code_id IS NULL
   AND (m.formula IS NULL OR m.formula = '');
