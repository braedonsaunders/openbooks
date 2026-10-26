import "server-only";
import type { SetupEntity } from "./registry";
import {
  entityPermissionRefusal,
  resolveEntity,
  setupEntityEnabled,
  setupScopeRefusal,
  type SetupActor,
  type SetupWriteResult,
} from "./write-shared";

/**
 * Bills of materials change only through the BOM command
 * (PUT /api/inventory/bom): a complete recipe with an expected version, a
 * reason, and one before/after audit. Generic single-row CRUD would let one
 * component change without a revision or reason, delete the last component,
 * or store a zero/negative quantity the build then refuses or misprices — so
 * every generic verb refuses here, in the preflight and in each command (the
 * assistant/MCP tools share the commands, not the route). Bulk migration
 * imports keep their own path in web/lib/data-io/setup-resources.ts.
 */
export function bomCommandOnly(entity: SetupEntity): SetupWriteResult | null {
  if (entity.key !== "bom-components") return null;
  return {
    status: 405,
    body: {
      error:
        "Bills of materials change only through the bill of materials command (PUT /api/inventory/bom), which records the revision, reason, and audit.",
    },
  };
}

/**
 * Command-owned setup entities never reach generic INSERT/UPDATE/DELETE. A
 * framework, fund pair, or functional mapping written as a plain row would
 * bypass the domain command that owns the write — so every generic verb
 * refuses here, in the preflight and in each command, before body parsing.
 * The remedy names the real endpoint.
 */
export function commandOwnedOnly(entity: SetupEntity): SetupWriteResult | null {
  if (!entity.command) return null;
  return {
    status: 405,
    body: {
      error: `This configuration changes only through its setup command (POST /api/admin/setup/${entity.key}/command). Open Nonprofit Setup to make this change.`,
    },
  };
}

/** Shipments keep the carrier they named, so a carrier is retired by
 *  clearing Active (an inactive carrier cannot be chosen on a shipment). */
export const CARRIER_DELETE_REFUSAL: SetupWriteResult = {
  status: 405,
  body: {
    error:
      "Carriers are kept for the shipments that name them: clear Active on the carrier instead of deleting it",
  },
};

/**
 * The refusals every mutation applies before it reads a body or touches the
 * database: unknown/disabled entity (404), declaration-owned, command-owned,
 * or shared reference data (405). The route calls this before parsing so a
 * malformed body on a refused entity still answers 405, and each command
 * re-runs it.
 */
export async function preflightSetupWrite(
  actor: SetupActor,
  entityKey: string,
  method: "create" | "update" | "delete",
): Promise<SetupWriteResult | null> {
  const entity = resolveEntity(entityKey);
  if (!entity) return { status: 404, body: { error: "unknown setup entity" } };
  if (!(await setupEntityEnabled(entity, actor.orgId)))
    return { status: 404, body: { error: "unknown setup entity" } };
  const permissionRefusal = entityPermissionRefusal(actor, entity);
  if (permissionRefusal) return permissionRefusal;
  const scopeRefusal = setupScopeRefusal(actor, entity);
  if (scopeRefusal) return scopeRefusal;
  const owned = bomCommandOnly(entity);
  if (owned) return owned;
  const commanded = commandOwnedOnly(entity);
  if (commanded) return commanded;
  if (method === "update" && entity.allowUpdate === false)
    return {
      status: 405,
      body: {
        error:
          "Configuration history is preserved; create a new record with its effective date to change this policy",
      },
    };
  if (method === "create" && entity.allowCreate === false)
    return { status: 405, body: { error: "This configuration is declared by its module" } };
  if (method === "delete" && entity.key === "carriers") return CARRIER_DELETE_REFUSAL;
  if (method === "delete" && entity.allowDelete === false)
    return { status: 405, body: { error: "Module setting history is preserved" } };
  if (entity.mutationPath)
    return {
      status: 405,
      body: {
        error: `This configuration must be saved through ${entity.mutationPath}, which validates the complete record.`,
      },
    };
  if (entity.readOnly) return { status: 405, body: { error: "read-only" } };
  if (method === "delete" && entity.key === "accounting-books")
    return { status: 405, body: { error: "archive-only" } };
  return null;
}
