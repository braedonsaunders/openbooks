import "server-only";
import { can } from "../authz";
import { normalizeMoneyValue } from "../cash/core";
import { trialBalance } from "../reports/statements";
import type { ApplicationContext } from "./context";
import { forbidden, invalidInput } from "./errors";

function reportDims(context: ApplicationContext) {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return undefined;
  if (allowed.size === 0) throw forbidden("subsidiary.restricted");
  return { subsidiaryIds: [...allowed] };
}

/** Trial balance — same `trialBalance` reader as the TB report and `trial_balance`. */
export async function listApplicationTrialBalance(
  context: ApplicationContext,
  input: { asOf: string },
) {
  if (!can(context.authz, "reports.read")) throw forbidden("reports.read");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) throw invalidInput("asOf must be YYYY-MM-DD");
  const rows = await trialBalance(input.asOf, reportDims(context), context.authz.user.orgId);
  return {
    asOf: input.asOf,
    accounts: rows.map((row) => ({
      number: row.number,
      name: row.name,
      type: row.type,
      debits: normalizeMoneyValue(String(row.debits ?? "0")),
      credits: normalizeMoneyValue(String(row.credits ?? "0")),
      balance: normalizeMoneyValue(String(row.balance ?? "0")),
    })),
  };
}
