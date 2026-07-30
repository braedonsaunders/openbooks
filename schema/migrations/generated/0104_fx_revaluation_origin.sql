BEGIN;

-- Asset remeasurement and monetary FX revaluation are different accounting
-- operations.  Historical code used the same origin tag for both, which could
-- make an asset impairment falsely satisfy the period-close FX control.
UPDATE journal_entries
   SET origin = 'fx_revaluation',
       updated_at = now()
 WHERE origin = 'revaluation'
   AND entry_number LIKE 'FXREVAL-%';

COMMIT;
