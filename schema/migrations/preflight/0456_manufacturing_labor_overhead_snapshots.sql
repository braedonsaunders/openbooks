-- OpenBooks upgrade preflight for 0456_manufacturing_labor_overhead_snapshots.
-- The widened allowed-kind check admits the two historical bases plus the
-- two manufacturing bases, so a rate stored under any other kind has no
-- defined reading and must be remapped before the constraint lands. Every
-- refused row names its stored kind.
SELECT '0456.unknown_overhead_rate_kind' AS code,
       'refuse' AS severity,
       format('overhead rate %s carries unknown kind %s', overhead_rates.id, overhead_rates.rate_kind) AS subject,
       'the overhead rate kind is not a recognized job-costing basis' AS detail,
       'Remap the rate to per_hour, percent, per_unit, or per_machine_hour before retrying the upgrade.' AS remedy
  FROM public.overhead_rates
 WHERE rate_kind NOT IN ('per_hour', 'percent');
