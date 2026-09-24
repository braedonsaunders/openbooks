import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";
import { committedFrRgduYearToDate } from "./rgdu-2026.ts";

test("RGDU history reads only earlier committed French stubs for the same employee and legal employer", async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const scheduleId = randomUUID();
  const employeeId = randomUUID();
  const employmentId = randomUUID();
  const otherEmploymentId = randomUUID();
  const otherEmployerId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  try {
    await db.execute(sql`update subsidiaries set country = 'FR', base_currency = 'EUR'
      where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, created_by, updated_by)
      values (${otherEmployerId}, ${org.orgId}, ${org.subsidiaryId}, ${`RGDU other ${tag}`}, 'EUR', 'FR', ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, ${`RGDU monthly ${tag}`}, 'monthly', 12, '2026-01-31', 0,
              true, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom, created_by, updated_by)
      values (${employeeId}, ${org.orgId}, 'person', ${`RGDU employee ${tag}`}, true,
              ${org.subsidiaryId}, '{}'::jsonb, ${actorId}, ${actorId})
    `);
    for (const id of [employmentId, otherEmploymentId]) {
      await db.execute(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, created_by, updated_by)
        values (${id}, ${org.orgId}, ${employeeId}, ${org.subsidiaryId}, ${actorId}, ${actorId})
      `);
    }

    const committed = async (input: {
      date: string; subsidiaryId: string; gross: string; smic: string; reduction: string; country?: string; contractId?: string;
    }) => {
      const documentId = randomUUID();
      const periodStart = `${input.date.slice(0, 7)}-01`;
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                               currency, status, created_by, updated_by)
        values (${org.orgId}, ${documentId}, 'pay_run', ${`RGDU-${documentId.slice(0, 8)}`},
                ${input.subsidiaryId}, ${input.date}, 'EUR', 'approved', ${actorId}, ${actorId})
      `);
      await db.execute(sql`
          insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                                pay_date, tax_year, run_status, run_type, created_by, updated_by)
          values (${documentId}, ${org.orgId}, ${scheduleId}, ${periodStart},
                  ${input.date}, ${input.date}, 2026, 'committed', 'bonus', ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id, country, country_source,
                               province, periods_per_year, pay_date, tax_year, currency_code, gross, factors,
                               created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${documentId}, ${employeeId}, ${input.contractId ?? employmentId}, ${input.country ?? "FR"}, 'calculation',
                'FR', 12, ${input.date}, 2026, 'EUR', ${input.gross},
                ${JSON.stringify({ FR_RGDU_SMIC: input.smic, FR_RGDU_ADJUSTMENT: input.reduction })}::jsonb,
                ${actorId}, ${actorId})
      `);
    };
    await committed({ date: "2026-05-31", subsidiaryId: org.subsidiaryId, gross: "1000", smic: "900", reduction: "300" });
    await committed({ date: "2026-07-31", subsidiaryId: org.subsidiaryId, gross: "5000", smic: "1700", reduction: "900" });
    await committed({ date: "2026-05-30", subsidiaryId: otherEmployerId, gross: "700", smic: "600", reduction: "180" });
    await committed({ date: "2026-05-28", subsidiaryId: org.subsidiaryId, gross: "600", smic: "500", reduction: "150", contractId: otherEmploymentId });
    await committed({ date: "2026-05-29", subsidiaryId: org.subsidiaryId, gross: "800", smic: "700", reduction: "210", country: "CA" });

    assert.deepEqual(await committedFrRgduYearToDate({
      tx: db,
      orgId: org.orgId,
      subsidiaryId: org.subsidiaryId,
      employeePartyId: employeeId,
      employmentId,
      taxYear: 2026,
      payDate: "2026-06-30",
      excludeDocumentId: randomUUID(),
    }), { remuneration: "1000.0000", smic: "900.0000", reduction: "300.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
