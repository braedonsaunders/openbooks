-- OpenBooks upgrade preflight for 0335_bank_statement_line_possible_duplicate.
--
-- Read-only mirror of what 0335 does. The flag column starts null on every
-- row and the foreign key arrives NOT VALID with its own VALIDATE step, so
-- the install has no operator-remediable precondition and never refuses.
-- The one thing worth surfacing: ID-less lines imported under the previous
-- policy carry deterministic synth-v1 fingerprints in bank_transaction_id.
-- 0335 retains them as-is — they stay valid unique keys, and scoped content
-- matching reads statement columns either way, so no backfill or repair
-- runs. One notice row per org holding such rows; zero rows means no org
-- predates the flag and the install is silent.
SELECT * FROM (
SELECT '0335.synth_fingerprint_rows' AS code,
       'notice' AS severity,
       format('org %s holds %s ID-less lines with previous-policy synth-v1 fingerprints', org_id, line_count) AS subject,
       format('%s lines carry deterministic content fingerprints from the previous import policy. The new import path never auto-skips on a bare ID collision and matches ID-less lines by statement columns within proven replay scope, so these rows keep working as ordinary unique keys', line_count) AS detail,
       'No operator action needed: migration 0335 retains the fingerprints and starts flagging unproven collisions instead of dropping them.' AS remedy
  FROM (SELECT org_id, count(*) AS line_count
          FROM public.bank_statement_lines
         WHERE bank_transaction_id LIKE 'synth-v1:%'
         GROUP BY org_id) synth_rows
 ORDER BY org_id
 LIMIT 50) notice_rows;
