import "server-only";

/**
 * Generic CRUD for every configuration entity in the Setup registry
 * (web/lib/setup/registry.ts) — the command layer behind
 * /api/admin/setup/[entity] AND the assistant/MCP setup-record tools, so
 * every surface shares column whitelisting, validation, the feature fence,
 * specialised per-entity rules, and audit evidence.
 *
 * SECURITY: table and column identifiers are taken ONLY from the registry
 * (never from the request body) and interpolated with sql.raw; every value is a
 * bound parameter. The request body cannot introduce a column name. Callers
 * authorize their configuration surface before reaching here: generic
 * setup routes and tools require admin.setup.manage, while the Benefits
 * adapter requires hrm.benefits.manage for benefit plans, contribution rules,
 * entitlement plans and effective employee policies.
 */

export {
  defaultPayComponentProgramExclusions,
  foldPayComponentSetupCreate,
  resolveEntity as resolveSetupEntity,
  savePayComponentEarningClassification,
  type SetupActor,
  type SetupWriteResult,
} from "./write-shared";
export { validateEntityIntegrity } from "./write-integrity";
export { preflightSetupWrite } from "./write-preflight";
export { createSetupRecord } from "./write-execute-create";
export { updateSetupRecord } from "./write-execute-update";
export { deleteSetupRecord } from "./write-execute-delete";
