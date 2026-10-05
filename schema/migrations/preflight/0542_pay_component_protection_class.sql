SELECT '0542.voluntary_deduction_in_disposable_earnings' AS code, 'notice' AS severity, c.code::text AS subject,
 'This deduction is subtracted from the disposable earnings a garnishment in the same organization is measured against. Disposable earnings are pay left after deductions required by law, so a voluntary deduction (a retirement deferral, an insurance premium, union dues) that is subtracted shrinks the protected base and under-withholds the order.' AS detail,
 'After the upgrade, open the pay component and turn off "Counts toward the protected base" unless the deduction is required by law; new deductions are created with it off.' AS remedy
FROM public.pay_components c
WHERE c.kind = 'deduction'
  AND c.system_key IS NULL
  AND c.protection_base = 'none'
  AND c.include_in_disposable_earnings
  AND c.is_active
  AND EXISTS (
    SELECT 1 FROM public.pay_components o
     WHERE o.org_id = c.org_id AND o.protection_base = 'disposable_earnings' AND o.is_active
  );
