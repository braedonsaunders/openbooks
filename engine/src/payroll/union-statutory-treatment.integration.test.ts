import { businessTodayInTx } from "../platform/business-date.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { upsertUnionFringe } from "./union.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

test(
  "union component defaults cover initial historical pay dates, bound future gaps and retain group-only or expired policy choices",
  { skip },
  async () => {
    const org = await createScratchOrg();
    const today = await businessTodayInTx(db, org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const agreementId = randomUUID(),
        groupId = randomUUID();
      await db.execute(sql`insert into union_agreements(id,org_id,name,is_active,created_by,updated_by)
      values(${agreementId},${org.orgId},'Collective agreement',true,${actorId},${actorId})`);
      await db.execute(sql`insert into worker_comp_groups(id,org_id,code,name,rate_percent)
      values(${groupId},${org.orgId},'GENERAL','General classification','1')`);
      const fringe = async (code: string) =>
        upsertUnionFringe(org.orgId, actorId, {
          agreementId,
          code,
          name: "Union contribution",
          calc: "per_hour_worked",
          value: "5",
          paidBy: "employee",
          liabilityAccountId: org.accounts.ap,
        });
      const initial = await fringe("INITIAL");
      assert.equal(
        (
          await db.execute<{ from: string }>(
            sql`select effective_from::text as "from"
      from pay_component_statutory_treatments where org_id=${org.orgId} and pay_component_id=${initial.componentId}`,
            "objects",
          )
        )[0]!.from,
        "0001-01-01",
      );
      for (const mode of ["FUTURE", "EXPIRED", "SCOPED"]) {
        const componentId = randomUUID();
        await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,basis)
        values(${componentId},${org.orgId},${`UNION-${mode}`},'Union contribution','deduction','fixed_amount')`);
        await db.execute(sql`insert into pay_component_statutory_treatments
        (org_id,pay_component_id,worker_comp_group_id,effective_from,effective_to,program_exclusions,vacationable)
        values(${org.orgId},${componentId},${mode === "SCOPED" ? groupId : null},
          case when ${mode}='FUTURE' then ${today}::date+10 else ${today}::date-10 end,
          case when ${mode}='EXPIRED' then ${today}::date-5 else null end,array['wcb'],false)`);
        const before = await db.execute(
          sql`select id,effective_from,effective_to,program_exclusions,vacationable from pay_component_statutory_treatments
        where org_id=${org.orgId} and pay_component_id=${componentId} order by effective_from`,
          "objects",
        );
        await fringe(mode);
        const after = await db.execute(
          sql`select id,effective_from,effective_to,program_exclusions,vacationable from pay_component_statutory_treatments
        where org_id=${org.orgId} and pay_component_id=${componentId} order by effective_from`,
          "objects",
        );
        if (mode === "FUTURE") {
          assert.equal(after.length, 2);
          assert.deepEqual(after[1], before[0]);
          const bound = (
            await db.execute<{ correct: boolean }>(
              sql`select effective_from=${today}::date and effective_to=${today}::date+9 as correct
          from pay_component_statutory_treatments where org_id=${org.orgId} and pay_component_id=${componentId} and program_exclusions='{}'`,
              "objects",
            )
          )[0]!;
          assert.equal(bound.correct, true);
        } else assert.deepEqual(after, before);
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
