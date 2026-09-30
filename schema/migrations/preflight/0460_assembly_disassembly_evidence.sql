-- OpenBooks upgrade preflight for 0460_assembly_disassembly_evidence.
SELECT '0460.disassembly_catalog_conflict' AS code,'refuse' AS severity,'Physical disassembly evidence' AS subject,
  'An object to be created already exists, or disassembly movements exist without their operation records.' AS detail,
  'Reconcile the catalog and applied-migration ledger before retrying the upgrade.' AS remedy
WHERE to_regclass('public.assembly_disassemblies') IS NOT NULL
  OR to_regprocedure('public.assembly_disassembly_immutable()') IS NOT NULL
  OR to_regprocedure('public.assembly_disassembly_binding()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_movements' AND column_name='assembly_disassembly_id')
  OR EXISTS(SELECT 1 FROM public.inventory_movements WHERE kind IN ('assembly_disassembly','assembly_recovery'));
