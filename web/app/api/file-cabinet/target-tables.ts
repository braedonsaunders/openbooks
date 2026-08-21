/**
 * Tables a file may be attached to — the allowlist of actual file_attachments
 * targets across the app (AttachmentPanel call sites and the engine's AP
 * capture writer). Anything else is refused at the API boundary instead of
 * being persisted against an arbitrary table name.
 *
 * Dependency-free by design so the membership decision stays a pure,
 * directly-unit-testable seam.
 */
export const ATTACHABLE_TARGET_TABLES: ReadonlySet<string> = new Set([
  'documents',
  'parties',
  'item_rate_versions',
  'fixed_assets',
  'compliance_records',
  'lien_waivers',
])

export function isAttachableTargetTable(targetTable: string): boolean {
  return ATTACHABLE_TARGET_TABLES.has(targetTable)
}
