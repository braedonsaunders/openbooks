SELECT '0705.rbc_std152_reserved_code' AS code, 'refuse' AS severity,
  'public.payment_formats/RBC-STD152' AS subject,
  'An existing format uses the native RBC STD152 reserved code with a different financial contract.' AS detail,
  'Preserve the existing format and its artifacts, review its code through Payment formats, and retry the native upgrade.' AS remedy
WHERE EXISTS (
  SELECT 1 FROM public.payment_formats
  WHERE code = 'RBC-STD152'
    AND (rail IS DISTINCT FROM 'rbc_std152_credit'
      OR direction IS DISTINCT FROM 'credit'
      OR country IS DISTINCT FROM 'CA'
      OR currency IS DISTINCT FROM 'CAD'
      OR file_extension IS DISTINCT FROM 'txt'
      OR content_type IS DISTINCT FROM 'text/plain; charset=us-ascii'
      OR formatter_script IS NOT NULL)
);
