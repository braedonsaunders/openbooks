/**
 * Module permission vocabulary mirror — the exact list the engine
 * persistence boundary enforces, without importing web.
 *
 * OWNERSHIP DIRECTION (read before editing): web/lib/modules/manifest.ts
 * builds the canonical MODULE_PLATFORM_PERMISSIONS from API_RECORD_TYPES
 * and is the vocabulary owner. This file is a MATERIALIZED MIRROR that
 * exists solely so engine/src/modules/installer.ts can validate requested
 * permissions against the exact list without importing web (engine never
 * imports from web). A caller-supplied catalogue parameter was tried and
 * removed: any catalogue-shaped parameter can be lied about, so the
 * boundary takes none — it reads this mirror instead.
 *
 * House precedent: REPORT_KINDS/FIELD_TYPES mirrors inside manifest.ts
 * itself, and 1e's ABSORBED_APP_MAPPED_PERMISSIONS mirror with its parity
 * test. Drift fails loudly: module-catalogue.test.ts asserts set-equality
 * with the contract owner, so adding a permission to the vocabulary means
 * updating BOTH lists in the same change.
 */

/**
 * Capability permissions a module may request, mirrored with citation from
 * MODULE_CAPABILITIES in web/lib/modules/manifest.ts.
 */
export const MODULE_CAPABILITIES = {
  /** Read custom records via platform CRUD (org-scoped). */
  RECORDS_READ: "records.read",
  /** Create, update, and delete published custom records via platform CRUD. */
  RECORDS_CREATE: "records.create",
  /** Governed ledger writes via the posting engine (draft + post). */
  GL_POST: "gl.post",
} as const;

/**
 * The module permission vocabulary, mirrored with citation from
 * MODULE_PLATFORM_PERMISSIONS in web/lib/modules/manifest.ts (the module
 * contract owner). Sorted. A requested permission outside this list is a
 * manifest error at the installer boundary — no caller input influences
 * the check.
 */
export const MODULE_PLATFORM_PERMISSIONS_MIRROR: readonly string[] = [
  "ap.create",
  "ap.pay",
  "ap.post",
  "ap.read",
  "ar.create",
  "ar.post",
  "ar.read",
  "assets.manage",
  "assets.read",
  "gl.post",
  "gl.read",
  "items.manage",
  "items.read",
  "parties.manage",
  "parties.read",
  "projects.manage",
  "projects.read",
  "records.create",
  "records.read",
];

const VOCABULARY_SET: ReadonlySet<string> = new Set(MODULE_PLATFORM_PERMISSIONS_MIRROR);

/** True when `key` is in the module permission vocabulary. */
export function isModulePermission(key: string): boolean {
  return VOCABULARY_SET.has(key);
}
