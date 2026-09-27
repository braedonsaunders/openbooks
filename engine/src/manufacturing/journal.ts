import type { Runner } from "../inventory/contracts.ts";
import { postInventoryEntry } from "../inventory/journal.ts";
import { ManufacturingPostingError } from "./errors.ts";
import { assertManufacturingFeature } from "./gate.ts";

type InventoryPostInput = Parameters<typeof postInventoryEntry>[1];
export type ManufacturingPostInput = Omit<InventoryPostInput, "origin"> & {
  custom?: Record<string, unknown>;
};

const EVIDENCE_KEYS = ["workOrderNumber", "bomRevision", "routingVersion"] as const;

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
