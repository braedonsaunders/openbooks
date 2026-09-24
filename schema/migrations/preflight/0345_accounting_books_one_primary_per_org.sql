SELECT
  'duplicate_primary_accounting_books'::text AS code,
  'refuse'::text AS severity,
  duplicates.org_id::text AS subject,
  format(
    'Organization %s has %s primary accounting books with ids: %s',
    duplicates.org_id,
    duplicates.book_count,
    duplicates.book_ids
  ) AS detail,
  'Review the listed book ids in /admin/setup/accounting-books and retain only the intended primary book before rerunning this migration.'::text AS remedy
FROM (
  SELECT
    org_id,
    count(*) AS book_count,
    string_agg(id::text, ', ' ORDER BY id::text) AS book_ids
  FROM public.accounting_books
  WHERE is_primary
  GROUP BY org_id
  HAVING count(*) > 1
) AS duplicates;
