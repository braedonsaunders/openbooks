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
export type ManufacturingPostInput = Omit<InventoryPostInput, "origin"> & {
  custom?: Record<string, unknown>;
};

const EVIDENCE_KEYS = ["workOrderNumber", "bomRevision", "routingVersion"] as const;

export type ManufacturingControlAccountRole = "mfgWip" | "mfgMaterialUsageVariance";

export async function manufacturingControlAccount(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
  role: ManufacturingControlAccountRole,
): Promise<string> {
  void subsidiaryId;
  let mappings: Partial<Record<ControlAccountRole, string>>;
  try {
    mappings = await loadControlAccounts(orgId);
  } catch (error) {
    if (error instanceof ControlAccountsIncompleteError && error.message.startsWith(`${role} control account`)) {
      const label = role === "mfgWip" ? "Manufacturing WIP" : "Material Usage Variance";
      const remedy = `Map ${label} under Setup → Company & Accounting → Control accounts.`;
      throw new ManufacturingError(`The Manufacturing control account role ${role} is not mapped to a valid account.`, {
        code: `${role}_account_invalid`, remedy,
      });
    }
    throw error;
  }

  const accountId = mappings[role];
  const label = role === "mfgWip" ? "Manufacturing WIP" : "Material Usage Variance";
  const remedy = `Map ${label} under Setup → Company & Accounting → Control accounts.`;
  if (!accountId) {
    throw new ManufacturingError(`The Manufacturing control account role ${role} is not mapped.`, {
      code: role === "mfgWip" ? "mfg_wip_account_missing" : `${role}_account_missing`, remedy,
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
      code: `${role}_account_invalid`, remedy,
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
  for (const key of EVIDENCE_KEYS) {
    if (typeof inputEvidence[key] !== "string" || inputEvidence[key].trim() === "") {
      throw new ManufacturingPostingError(
        `manufacturing posting requires non-empty custom evidence key ${key}`,
      );
    }
  }
  const { workOrderNumber, bomRevision, routingVersion, ...otherEvidence } = inputEvidence;
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
