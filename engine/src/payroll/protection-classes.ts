import type { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { employerFact } from "./employer-facts.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import { protectionExemptFloor } from "./limits.ts";
import type { PayrollProtectionClass } from "./pack-types.ts";

/**
 * This period's exempt floor for every protection class a protected line
 * names, resolved against the employee's pack and the legal employer's
 * effective-dated facts.
 *
 * A class is the legal kind of order (`pay_components.protection_class`)
 * and the pack declares what it means. A class the pack does not declare
 * refuses the run by name — another pack's class would carry another
 * country's limit. A class whose floor needs a wage the legal employer has
 * not recorded for the pay date refuses by name too: garnishing without
 * the floor would take pay the law keeps out of reach, and a guessed wage
 * is a number nobody entered.
 */
export async function resolveProtectionExemptFloors(args: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  subsidiaryId: string | null;
  country: string;
  classes: readonly PayrollProtectionClass[];
  payDate: string;
  periodsPerYear: number;
  employeeLabel: string;
  lines: readonly { description: string; protectionClass?: string | null }[];
}): Promise<Record<string, string>> {
  const floors: Record<string, string> = {};
  for (const line of args.lines) {
    const key = line.protectionClass;
    if (!key || key in floors) continue;
    const declared = args.classes.find((candidate) => candidate.key === key);
    if (!declared) {
      const offered = args.classes.map((candidate) => candidate.label).join(", ");
      throw new PayrollError(
        `${args.employeeLabel}: ${line.description} is set to protection class "${key}", which the ${args.country} `
        + `payroll pack does not declare${offered ? ` (it declares: ${offered})` : " (it declares none)"}. `
        + "Choose one of the pack's classes, or none, on the pay component in Payroll Setup → Components.",
      );
    }
    if (!declared.exemptFloor) continue;
    const fact = employerFact(args.country, declared.exemptFloor.employerFactKey);
    const wage = await resolveStoredEmployerFact({
      tx: args.tx, orgId: args.orgId, subsidiaryId: args.subsidiaryId,
      country: args.country, factKey: fact.key, asOf: args.payDate,
    });
    if (wage === null) {
      throw new PayrollError(
        `${args.employeeLabel}: ${line.description} (${declared.label}) may not reach the protected base below `
        + `${declared.exemptFloor.weeklyHours} × the ${fact.label.toLowerCase()} per week, and no ${fact.label.toLowerCase()} `
        + `is recorded for ${args.payDate}. Record it in Payroll Setup → Employer facts, effective from the date `
        + "it applies, before calculating.",
      );
    }
    floors[key] = protectionExemptFloor(wage, declared.exemptFloor.weeklyHours, args.periodsPerYear);
  }
  return floors;
}
