import { sql } from "drizzle-orm";
import type { Runner } from "../inventory/contracts.ts";
import { assertInventoryAccountsPostable } from "../inventory/journal.ts";
import { postInventoryEntry } from "../inventory/journal.ts";
import {
  CONTROL_ACCOUNT_TYPE_POLICY,
  ControlAccountsIncompleteError,
  loadControlAccounts,
  type ControlAccountRole,
} from "../records/control-accounts.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { ManufacturingError, ManufacturingPostingError } from "./errors.ts";
import { assertManufacturingFeature } from "./gate.ts";

type InventoryPostInput = Parameters<typeof postInventoryEntry>[1];
export type ManufacturingPostInput = Omit<InventoryPostInput, "origin" | "custom"> & {
  custom: ManufacturingEvidence;
};

const EVIDENCE_KEYS = ["workOrderNumber", "bomRevision", "routingVersion"] as const;

/**
 * Posting evidence scope for a manufacturing journal. Work-order postings
 * carry one released work order with its frozen BOM and routing; period-pool
 * postings settle a whole period pool (future pool-level labor/overhead
 * variance settlement) and are identified by the entry's own
 * period/book/subsidiary — never by a work order. The two shapes are
 * mutually exclusive: a caller passes exactly one scope.
 */
export type ManufacturingEvidenceScope = "work-order" | "period-pool";

/**
 * Work-order posting evidence: one released work order, frozen BOM + routing.
 * Callers may attach additional source-specific extension keys, which ride
 * through to storage alongside the mapped snake-case evidence.
 */
export interface ManufacturingWorkOrderEvidence {
  /** Defaults to "work-order" when omitted, preserving existing callers. */
  scope?: "work-order";
  workOrderNumber: string;
  bomRevision: string;
  routingVersion: string;
  /** Extension capability lives only on the work-order branch. */
  [key: string]: unknown;
}

/**
 * Period-pool posting evidence for pool-level variance settlement. Admits
 * only its scope: the pool is the entry's own period, book, and
 * subsidiary, so no work-order number, BOM, routing, or any other key is
 * carried. Work-order keys are statically excluded and every extra
 * supplied key is refused at runtime, never stored.
 */
export interface ManufacturingPeriodPoolEvidence {
  scope: "period-pool";
  workOrderNumber?: never;
  bomRevision?: never;
  routingVersion?: never;
}

export type ManufacturingEvidence =
  | ManufacturingWorkOrderEvidence
  | ManufacturingPeriodPoolEvidence;

/** Stored scope marker for period-pool settlement postings. */
const PERIOD_POOL_SCOPE_KEY = "settlement_scope";
const PERIOD_POOL_SCOPE_VALUE = "period-pool";

export type ManufacturingControlAccountRole =
  | "mfgWip"
  | "mfgMaterialUsageVariance"
  | "mfgLaborEfficiencyVariance"
  | "mfgOverheadVariance"
  | "mfgOverheadApplied"
  | "laborClearing";

interface ManufacturingControlAccountMeta {
  /** Operator-facing account label used in the mapping remedy. */
  label: string;
  /** Refusal code when the role has no mapping. */
  missingCode: string;
  /** Refusal code when the mapping is invalid or unusable. */
  invalidCode: string;
}

/**
 * One authoritative mapping owns every manufacturing control-account role's
 * operator label and refusal codes. The allowed account-type policy stays
 * owned by CONTROL_ACCOUNT_TYPE_POLICY and loadControlAccounts remains the
 * only control reader: no account ids are hardcoded here.
 */
const MANUFACTURING_CONTROL_ACCOUNT_META: Record<
  ManufacturingControlAccountRole,
  ManufacturingControlAccountMeta
> = {
  mfgWip: {
    label: "Manufacturing WIP",
    missingCode: "mfg_wip_account_missing",
    invalidCode: "mfgWip_account_invalid",
  },
  mfgMaterialUsageVariance: {
    label: "Material Usage Variance",
    missingCode: "mfgMaterialUsageVariance_account_missing",
    invalidCode: "mfgMaterialUsageVariance_account_invalid",
  },
  mfgLaborEfficiencyVariance: {
    label: "Labor Efficiency Variance",
    missingCode: "mfgLaborEfficiencyVariance_account_missing",
    invalidCode: "mfgLaborEfficiencyVariance_account_invalid",
  },
  mfgOverheadVariance: {
    label: "Manufacturing Overhead Variance",
    missingCode: "mfgOverheadVariance_account_missing",
    invalidCode: "mfgOverheadVariance_account_invalid",
  },
  mfgOverheadApplied: {
    label: "Manufacturing Overhead Applied",
    missingCode: "mfgOverheadApplied_account_missing",
    invalidCode: "mfgOverheadApplied_account_invalid",
  },
  laborClearing: {
    label: "Labor Clearing",
    missingCode: "laborClearing_account_missing",
    invalidCode: "laborClearing_account_invalid",
  },
};

export async function manufacturingControlAccount(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
  role: ManufacturingControlAccountRole,
): Promise<string> {
  void subsidiaryId;
  const meta = MANUFACTURING_CONTROL_ACCOUNT_META[role];
  const remedy = `Map ${meta.label} under Setup → Company & Accounting → Control accounts.`;
  let mappings: Partial<Record<ControlAccountRole, string>>;
  try {
    mappings = await loadControlAccounts(orgId);
  } catch (error) {
    if (error instanceof ControlAccountsIncompleteError && error.message.startsWith(`${role} control account`)) {
      throw new ManufacturingError(`The Manufacturing control account role ${role} is not mapped to a valid account.`, {
        code: meta.invalidCode, remedy,
      });
    }
    throw error;
  }

  const accountId = mappings[role];
  if (!accountId) {
    throw new ManufacturingError(`The Manufacturing control account role ${role} is not mapped.`, {
      code: meta.missingCode, remedy,
    });
  }

  const account = (await tx.execute<{
    id: string; type: string; is_active: boolean; is_summary: boolean;
  }>(sql`
    select id, type, is_active, is_summary from accounts
     where org_id=${orgId} and id=${accountId} for share`)).rows[0];
  const allowedTypes: readonly string[] = CONTROL_ACCOUNT_TYPE_POLICY[role];
  if (!account || !account.is_active || account.is_summary || !allowedTypes.includes(account.type)) {
    throw new ManufacturingError(`The Manufacturing control account role ${role} is not mapped to an active posting account.`, {
      code: meta.invalidCode, remedy,
    });
  }
  await assertInventoryAccountsPostable(tx as Runner, orgId, [account.id]);
  return account.id;
}

export async function postManufacturingEntry(
  tx: Runner,
  p: ManufacturingPostInput,
): Promise<string> {
  await assertManufacturingFeature(tx, p.orgId, "manufacturing");
  const inputEvidence = p.custom ?? {};
  const scope: unknown = inputEvidence.scope ?? "work-order";
  if (scope === "period-pool") {
    for (const key of Object.keys(inputEvidence)) {
      if (key !== "scope") {
        throw new ManufacturingPostingError(
          `manufacturing period-pool settlement must not carry evidence key "${key}"; remove it because period, book, and subsidiary are the journal's governed fields — post work-order evidence under scope "work-order" instead`,
        );
      }
    }
    return postInventoryEntry(tx, {
      ...p,
      origin: "manufacturing",
      custom: {
        [PERIOD_POOL_SCOPE_KEY]: PERIOD_POOL_SCOPE_VALUE,
      },
    });
  }
  if (scope !== "work-order") {
    throw new ManufacturingPostingError(
      `manufacturing posting scope must be "work-order" or "period-pool"`,
    );
  }
  for (const key of EVIDENCE_KEYS) {
    if (typeof inputEvidence[key] !== "string" || inputEvidence[key].trim() === "") {
      throw new ManufacturingPostingError(
        `manufacturing posting requires non-empty custom evidence key ${key}`,
      );
    }
  }
  const { workOrderNumber, bomRevision, routingVersion, scope: _declaredScope, ...otherEvidence } = inputEvidence;
  void _declaredScope;
  return postInventoryEntry(tx, {
    ...p,
    origin: "manufacturing",
    custom: {
      ...otherEvidence,
      work_order_number: workOrderNumber,
      bom_revision: bomRevision,
      routing_version: routingVersion,
    },
  });
}
