SELECT '0483.unknown_run_type' AS code,'refuse' AS severity,run_type AS subject,
 'A pay run carries a type outside the widened vocabulary and the broader check would still admit it silently.' AS detail,
 'Recode the listed run type to regular, bonus, termination, retro, or supplemental before applying this migration.' AS remedy
FROM public.pay_runs WHERE run_type NOT IN ('regular','bonus','termination','retro','supplemental') GROUP BY run_type;
