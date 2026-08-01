-- Overhead becomes a rich statistical allocation config (OverheadSource) instead
-- of a thin CostSource. Backfill existing project_types.financial_profile.overhead:
--   {source:'none'}                        → {method:'none'}
--   {source:'account_group', dimension:X}  → {method:'posted_gl_account_group', accountGroup:{dimension:X}}
-- Idempotent: only rewrites rows still on the old {source:...} shape.

UPDATE project_types
   SET financial_profile = jsonb_set(
         financial_profile,
         '{overhead}',
         CASE
           WHEN financial_profile -> 'overhead' ->> 'source' = 'account_group'
             THEN jsonb_build_object(
                    'method', 'posted_gl_account_group',
                    'accountGroup', jsonb_build_object('dimension', financial_profile -> 'overhead' ->> 'dimension')
                  )
           ELSE jsonb_build_object('method', 'none')
         END
       )
 WHERE financial_profile -> 'overhead' ? 'source';
