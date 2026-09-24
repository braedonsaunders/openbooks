SELECT
  'hrm_leave_attachment_missing_file'::text AS code,
  'refuse'::text AS severity,
  r.id::text AS subject,
  format('Leave request %s names attachment %s, but that file does not exist in organization %s.', r.id, r.attachment_id, r.org_id) AS detail,
  'Restore the referenced File Cabinet file or replace the evidence with a valid organization-owned file before retrying the upgrade.'::text AS remedy
FROM public.hrm_leave_requests r
WHERE r.attachment_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.files f
     WHERE f.org_id = r.org_id
       AND f.id = r.attachment_id
  );
