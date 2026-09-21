/**
 * HR document-template body normalization (pure — no server imports, so
 * unit tests run it directly like hrm-review-template.ts).
 *
 * The Setup drawer edits signer_roles and merge_fields as structured slot
 * fields (three signer booleans in canonical employee → manager → hr
 * order plus a merge-key string array; never raw JSON —
 * registry.test.ts bars json-kind workforce fields): this fold runs
 * before buildRow on both create and edit so the slot keys never reach
 * the column writer. Shape refusal (unknown merge key, acknowledgment
 * with signers, signature with no signers) is raised by
 * validateEntityIntegrity in write.ts with the engine's own words, so
 * the caller receives a 400 naming the field, not an exception.
 */

const SIGNER_SLOTS = ['signEmployee', 'signManager', 'signHr'] as const

const SLOT_ROLE: Record<(typeof SIGNER_SLOTS)[number], string> = {
  signEmployee: 'employee',
  signManager: 'manager',
  signHr: 'hr',
}

function hasSignerSlots(body: Record<string, unknown>): boolean {
  return SIGNER_SLOTS.some((key) => body[key] !== undefined)
}

export function normalizeHrmDocumentTemplateInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-document-templates') return body
  if (!hasSignerSlots(body) && body.mergeFields === undefined) return body
  const out: Record<string, unknown> = { ...body }
  if (hasSignerSlots(body)) {
    // Slot keys win over a direct array the way the review-template fold
    // does: the drawer always sends the complete slot set it offered.
    const roles = SIGNER_SLOTS.filter((key) => out[key] === true).map((key) => SLOT_ROLE[key])
    out.signerRoles = roles
    for (const key of SIGNER_SLOTS) delete out[key]
  }
  return out
}

/** Merge a partial slot edit over the stored row (review-template precedent). */
export function mergeTemplateSlots(
  current: { signer_roles?: unknown; merge_fields?: unknown } | null,
  body: Record<string, unknown>,
): { signerRoles: unknown; mergeFields: unknown } {
  const stored = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  return {
    signerRoles: body.signerRoles ?? stored(current?.signer_roles),
    mergeFields: body.mergeFields ?? stored(current?.merge_fields),
  }
}
