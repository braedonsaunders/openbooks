import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { resolveProjectActualCosts } from "./financials.ts";
import {
  recordProjectFinancialAdjustment,
  reverseProjectFinancialAdjustment,
} from "./financial-adjustments.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function causedByMessage(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && candidate.message.includes(expected)) return true;
    current = candidate.cause;
  }
  return false;
}

test(
  "project financial adjustments retain exact, auditable source evidence and reverse append-only",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Financial Adjustment Operator", "admin"),
      );
      const projectId = randomUUID();
      await withBypass(() => db.execute(sql`
        insert into projects
          (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values
          (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-ADJ',
           'Adjustment evidence job', ${org.customerId}, 'active', true, '{}'::jsonb)
      `));

      const input = {
        orgId: org.orgId,
        projectId,
        adjustmentDate: org.date,
        measure: "actual_cost" as const,
        amount: "75.12",
        reason: "approved source correction",
        sourceSystem: "legacy-import",
        sourceRef: "cost-correction-2048",
        evidence: { ticket: "FIN-2048", approvedBy: actorId },
        actorId,
      };
      const original = await withOrgContext(org.orgId, () =>
        recordProjectFinancialAdjustment(input),
      );
      assert.deepEqual(original, {
        id: original.id,
        measure: "actual_cost",
        amount: "75.1200",
        existing: false,
      });

      const costs = await withOrgContext(org.orgId, () =>
        resolveProjectActualCosts(org.orgId, [projectId]),
      );
      assert.equal(costs.profileErrors.size, 0);
      assert.equal(costs.costs.get(projectId), "75.1200");

      const replay = await withOrgContext(org.orgId, () =>
        recordProjectFinancialAdjustment(input),
      );
      assert.deepEqual(replay, { ...original, existing: true });
      await assert.rejects(
        withOrgContext(org.orgId, () => recordProjectFinancialAdjustment({
          ...input,
          amount: "76.12",
        })),
        /source identity legacy-import\/cost-correction-2048 already has different evidence/,
      );

      await assert.rejects(
        withOrgContext(org.orgId, () => db.execute(sql`
          update project_financial_adjustments set amount = '76.1200'
           where id = ${original.id} and org_id = ${org.orgId}
        `)),
        (error: unknown) => causedByMessage(
          error,
          "project financial adjustments are append-only; post a reversing adjustment",
        ),
      );
      const afterRejectedMutation = await withOrgContext(org.orgId, () =>
        resolveProjectActualCosts(org.orgId, [projectId]),
      );
      assert.equal(afterRejectedMutation.costs.get(projectId), "75.1200");

      const reversal = await withOrgContext(org.orgId, () =>
        reverseProjectFinancialAdjustment({
          orgId: org.orgId,
          adjustmentId: original.id,
          adjustmentDate: org.date,
          reason: "reverse approved correction",
          actorId,
          sourceSystem: "legacy-import",
          sourceRef: "cost-correction-2048-reversal",
        }),
      );
      assert.equal(reversal.measure, "actual_cost");
      assert.equal(reversal.amount, "-75.1200");
      assert.equal(reversal.existing, false);

      const finalCost = await withOrgContext(org.orgId, async () => {
        const resolved = await resolveProjectActualCosts(org.orgId, [projectId]);
        const audit = await db.execute<{
          row_id: string;
          actor_id: string | null;
          action: string;
          amount: string;
          reverses_adjustment_id: string | null;
        }>(sql`
          select a.row_id, a.actor_id, a.action,
                 a.changes #>> '{after,amount}' as amount,
                 pfa.reverses_adjustment_id
            from audit_log a
            join project_financial_adjustments pfa
              on pfa.id = a.row_id and pfa.org_id = a.org_id
           where a.org_id = ${org.orgId}
             and a.table_name = 'project_financial_adjustments'
             and pfa.project_id = ${projectId}
           order by pfa.reverses_adjustment_id nulls first
        `);
        assert.deepEqual(audit.rows, [
          {
            row_id: original.id,
            actor_id: actorId,
            action: "insert",
            amount: "75.1200",
            reverses_adjustment_id: null,
          },
          {
            row_id: reversal.id,
            actor_id: actorId,
            action: "insert",
            amount: "-75.1200",
            reverses_adjustment_id: original.id,
          },
        ]);
        return resolved.costs.get(projectId);
      });
      assert.equal(finalCost, "0.0000");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
