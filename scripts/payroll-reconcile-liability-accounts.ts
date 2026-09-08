/**
 * One-time migration reconciliation from reviewed original payroll evidence.
 * Usage: node --import tsx scripts/payroll-reconcile-liability-accounts.ts
 *   --org UUID --actor UUID --input /absolute/reviewed-rows.json [--apply]
 * Defaults to validation with rollback. Rows: {lineId, accountId, reason, reference}[].
 * Uses the normal tenant transaction, live payroll.manage permission and DB audit guard.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pool, withOrgTransaction } from "../engine/src/db.ts";
import {
  reconcilePayrollLiabilityAccounts,
  type PayrollLiabilityReconciliation,
} from "../engine/src/payroll-liability-reconciliation.ts";

const previewRollback = new Error(
  "Preview complete: rollback reviewed reconciliation",
);
async function main() {
  const { values } = parseArgs({
    options: {
      org: { type: "string" },
      actor: { type: "string" },
      input: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!values.org || !values.actor || !values.input)
    throw new Error(
      "Required: --org UUID --actor UUID --input reviewed-rows.json; add --apply only after reviewing the evidence.",
    );
  const rows: unknown = JSON.parse(await readFile(values.input, "utf8"));
  if (!Array.isArray(rows))
    throw new Error("Input must be an array of reviewed attribution rows.");
  let count = 0;
  try {
    await withOrgTransaction(values.org, async () => {
      count = await reconcilePayrollLiabilityAccounts({
        orgId: values.org!,
        actorId: values.actor!,
        rows: rows as PayrollLiabilityReconciliation[],
      });
      if (!values.apply) throw previewRollback;
    });
  } catch (error) {
    if (error !== previewRollback) throw error;
  }
  console.log(
    `${values.apply ? "Reconciled and audited" : "Validated and rolled back"} ${count} payroll liability lines.`,
  );
}
void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
