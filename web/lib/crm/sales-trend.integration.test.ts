import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  pool,
  withBypassContext,
  withOrgContext,
} from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";
import { REPORT_ENTITY_MAP, runCustomQuery } from "@openbooks/reports";
import { salesTrendQuery, salesTrendFromReport } from "./sales-trend";

test(
  "sales trends preserve exact currency-separated monthly amounts, reversals, business dates and tenant scopes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withOrgContext(org.orgId, async () => {
        const rep = (
          await db.execute<{ id: string }>(
            sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${org.orgId},'employee','Sales trend representative',${org.subsidiaryId}) returning id`,
          )
        ).rows[0]!.id;
        await db.execute(
          sql`insert into employee_roles(org_id,party_id,is_sales_rep) values(${org.orgId},${rep},true)`,
        );
        async function credit(
          currency: string,
          amount: string,
          date: string | null,
          metric = "closed_won",
          employeeId: string | null = rep,
        ) {
          return (
            await db.execute<{ id: string }>(
              sql`insert into crm_sales_evidence(org_id,source_kind,source_id,source_number,event_kind,metric,employee_id,subsidiary_id,currency,amount,effective_date) values(${org.orgId},'opportunity',${randomUUID()},'TREND-TEST','credit',${metric},${employeeId},${org.subsidiaryId},${currency},${amount}::numeric,${date}::date) returning id`,
            )
          ).rows[0]!.id;
        }
        const first = await credit("USD", "100.0001", "2026-09-12");
        await credit("USD", "0.0002", "2026-09-30");
        await db.execute(
          sql`insert into crm_sales_evidence(org_id,source_kind,source_id,source_number,event_kind,metric,employee_id,subsidiary_id,currency,amount,effective_date,reverses_id) values(${org.orgId},'opportunity',${randomUUID()},'TREND-REVERSAL','reversal','closed_won',${rep},${org.subsidiaryId},'USD',-100.0001,'2026-09-15',${first})`,
        );
        await credit("CAD", "1234.5678", "2026-09-20");
        await credit("USD", "40.5", "2026-08-20", "net_invoiced");
        await credit("USD", "999", "2025-09-30");
        await credit("USD", "999", "2026-10-02");
        await credit("USD", "999", null);
        await credit("USD", "999", "2026-09-30", "closed_won", null);
        const query = salesTrendQuery(rep, "2026-10-01");
        const options = {
          entityMap: REPORT_ENTITY_MAP,
          orgId: org.orgId,
          allowedSubsidiaryIds: [org.subsidiaryId],
        };
        const report = await runCustomQuery(pool, query, options);
        const trend = salesTrendFromReport("2026-10-01", report);
        assert.equal(trend.months.length, 12);
        assert.equal(trend.months[0], "2025-11-01");
        assert.equal(trend.months.at(-1), "2026-10-01");
        assert.deepEqual(
          trend.points.sort((a, b) =>
            (a.month + a.currency).localeCompare(b.month + b.currency),
          ),
          [
            {
              month: "2026-08-01",
              currency: "USD",
              metric: "net_invoiced",
              amount: "40.5",
            },
            {
              month: "2026-09-01",
              currency: "CAD",
              metric: "closed_won",
              amount: "1234.5678",
            },
            {
              month: "2026-09-01",
              currency: "USD",
              metric: "closed_won",
              amount: "0.0002",
            },
          ],
        );
        const originalTimezone = process.env.TZ;
        try {
          for (const timezone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
            process.env.TZ = timezone;
            const inTimezone = salesTrendFromReport(
              "2026-10-01",
              await runCustomQuery(pool, query, options),
            );
            assert.deepEqual(
              inTimezone.points.sort((a, b) =>
                (a.month + a.currency).localeCompare(b.month + b.currency),
              ),
              trend.points,
              `calendar buckets must survive ${timezone}`,
            );
          }
        } finally {
          if (originalTimezone === undefined) delete process.env.TZ;
          else process.env.TZ = originalTimezone;
        }
        for (const restricted of [
          { ...options, allowedSubsidiaryIds: [] },
          { ...options, orgId: randomUUID() },
        ]) {
          assert.deepEqual(
            salesTrendFromReport(
              "2026-10-01",
              await runCustomQuery(pool, query, restricted),
            ).points,
            [],
          );
        }
        assert.deepEqual(
          salesTrendFromReport(
            "2026-10-01",
            await runCustomQuery(
              pool,
              salesTrendQuery(randomUUID(), "2026-10-01"),
              options,
            ),
          ).points,
          [],
        );
        const damaged = structuredClone(report);
        damaged.groups[0]!.rows[0]![3] = "unreadable";
        assert.throws(
          () => salesTrendFromReport("2026-10-01", damaged),
          /Open the sales evidence report/,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
