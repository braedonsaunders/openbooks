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
-- Deterministic and idempotent: a re-run matches no rows, because healed
-- rows no longer carry basis 'tax_amount'.

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
