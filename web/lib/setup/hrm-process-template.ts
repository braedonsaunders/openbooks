/**
 * HRM process template body normalization (pure — no server imports, so
 * unit tests run it directly like tax-return-form.ts).
 *
 * The Setup drawer edits the applies_to filter as two structured ref
 * selects (subsidiary, department; empty means all) backed by STORED
 * GENERATED columns that are readable but never written. This fold runs
 * before buildRow on both create and edit so the virtual slot keys never
 * reach the column writer; the shape and org-visibility proofs stay in
 * validateEntityIntegrity in write.ts.
 */

export function normalizeHrmProcessTemplateInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-process-templates') return body
  const hasSlots =
    body.appliesEmployerSubsidiaryId !== undefined || body.appliesDepartmentId !== undefined
  if (!hasSlots) return body
  const slot = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    return String(value)
  }
  const { appliesEmployerSubsidiaryId, appliesDepartmentId, ...rest } = body
  return {
    ...rest,
    appliesTo: {
      employer_subsidiary_id: slot(appliesEmployerSubsidiaryId),
      department_id: slot(appliesDepartmentId),
    },
  }
}
