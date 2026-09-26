/**
 * One-time migration reconciliation from reviewed original payroll evidence.
 * Usage: node --import tsx scripts/payroll-reconcile-accounts.ts
 *   --kind filing|liability --org UUID --actor UUID --input /absolute/reviewed-rows.json [--apply]
 * Defaults to validation with rollback.
 *   filing rows:    {stubId, filingAccountId, reason, reference}[]
 *   liability rows: {lineId, accountId, reason, reference}[]
 * Uses the normal tenant transaction, live payroll.manage permission and DB audit guard.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pool, withOrgTransaction } from "../engine/src/platform/db.ts";
import {
  reconcilePayrollFilingAccounts,
  type PayrollFilingReconciliation,
} from "../engine/src/payroll/filing-reconciliation.ts";
import {
  reconcilePayrollLiabilityAccounts,
  type PayrollLiabilityReconciliation,
} from "../engine/src/payroll/liability-reconciliation.ts";

type Reconcile = (input: { orgId: string; actorId: string; rows: unknown[] }) => Promise<number>;

const KINDS: Record<string, { reconcile: Reconcile; noun: string }> = {
  filing: {
    reconcile: ({ rows, ...rest }) =>
      reconcilePayrollFilingAccounts({ ...rest, rows: rows as PayrollFilingReconciliation[] }),
    noun: "pay stubs",
  },
  liability: {
    reconcile: ({ rows, ...rest }) =>
      reconcilePayrollLiabilityAccounts({ ...rest, rows: rows as PayrollLiabilityReconciliation[] }),
    noun: "payroll liability lines",
  },
};

const previewRollback = new Error(
  "Preview complete: rollback reviewed reconciliation",
);
async function main() {
  const { values } = parseArgs({
    options: {
      kind: { type: "string" },
      org: { type: "string" },
      actor: { type: "string" },
      input: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const kind = values.kind ? KINDS[values.kind] : undefined;
  if (!kind || !values.org || !values.actor || !values.input)
    throw new Error(
      "Required: --kind filing|liability --org UUID --actor UUID --input reviewed-rows.json; add --apply only after reviewing the evidence.",
    );
  const rows: unknown = JSON.parse(await readFile(values.input, "utf8"));
  if (!Array.isArray(rows))
    throw new Error("Input must be an array of reviewed attribution rows.");
  let count = 0;
  try {
    await withOrgTransaction(values.org, async () => {
      count = await kind.reconcile({
        orgId: values.org!,
        actorId: values.actor!,
        rows,
      });
      if (!values.apply) throw previewRollback;
    });
  } catch (error) {
    if (error !== previewRollback) throw error;
  }
  console.log(
    `${values.apply ? "Reconciled and audited" : "Validated and rolled back"} ${count} ${kind.noun}.`,
  );
}
void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
