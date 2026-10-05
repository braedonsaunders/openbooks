SELECT '0540.reserved_item_settled_outside_run' AS code, 'notice' AS severity,
 (run.run_number || ' / ' || coalesce(document.document_number, item.source_open_line_id::text))::text AS subject,
 'This open item is reserved by a live payment run but was also settled outside that run after it was reserved; the run may pay it a second time.' AS detail,
 'Before the run posts, cancel or roll back the run, or reverse the outside settlement if the run is the intended payment.' AS remedy
FROM public.payment_run_items item
JOIN public.payment_runs run ON run.id = item.payment_run_id AND run.org_id = item.org_id
LEFT JOIN public.documents document ON document.id = item.source_document_id AND document.org_id = item.org_id
LEFT JOIN public.payment_instructions instruction ON instruction.id = item.payment_instruction_id AND instruction.org_id = item.org_id
WHERE item.status = 'selected'
  AND EXISTS (
    SELECT 1
      FROM public.applications application
      JOIN public.journal_lines line ON line.id = application.from_line_id AND line.org_id = application.org_id
      JOIN public.journal_entries entry ON entry.id = line.entry_id AND entry.org_id = line.org_id
     WHERE application.org_id = item.org_id
       AND application.unapplied_at IS NULL
       AND item.source_open_line_id IN (application.from_line_id, application.to_line_id)
       AND application.created_at > item.created_at
       AND entry.source_document_id IS DISTINCT FROM instruction.payment_document_id
  );
