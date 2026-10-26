import "server-only";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { auditSetupChange } from "./audit";

/** Every newly created component starts with an explicit, audited dated policy. */
export async function createInitialComponentTreatment(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    componentId: string;
    vacationable: unknown;
    programExclusions: readonly string[];
    requestId?: string;
  },
): Promise<void> {
  if (typeof input.vacationable !== "boolean") {
    throw new Error("The saved component has no explicit vacation-base creation default");
  }
  const treatment = (
    await tx.execute(
      sql`
    insert into pay_component_statutory_treatments
      (org_id, pay_component_id, effective_from, program_exclusions, vacationable, created_by, updated_by)
    values (${input.orgId}, ${input.componentId}, current_date,
      ${sql.param([...input.programExclusions])}, ${input.vacationable}, ${input.actorId}, ${input.actorId})
    returning *
  `,
      "objects",
    )
  )[0];
  if (!treatment) throw new Error("The component statutory treatment was not created");
  await auditSetupChange(
    {
      orgId: input.orgId,
      table: "pay_component_statutory_treatments",
      rowId: String(treatment.id),
      action: "insert",
      changes: {
        after: treatment,
        reason: "Initial statutory treatment created with the pay component.",
      },
      actorId: input.actorId,
      requestId: input.requestId,
    },
    tx,
  );
}
