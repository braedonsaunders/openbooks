import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";

const { listApplicationBudgets } = await import("./budgets");
const { updateBudgetCells } = await import("./budgets");

test("disabled budgets are refused with the Features-page remedy", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const context = {
    authz: {
      user: { orgId: org.orgId },
      permissions: new Set(["budgets.read"]),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: "budget-read-feature-test",
    apiKeyId: null,
  } as unknown as ApplicationContext;
  try {
    await withBypassContext(() =>
      db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"budgets":false}'::jsonb,
           true
         )
       where id = ${org.orgId}
    `),
    );
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(
        listApplicationBudgets(context),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === "not_found" &&
          error.status === 404 &&
          error.message === "budgets is off; enable it from GET /api/v1/settings/features",
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("cell writes refuse a scenario that includes an out-of-scope subsidiary", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = randomUUID();
  const hidden = randomUUID();
  const scenarioId = randomUUID();
  const context = {
    authz: {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["budgets.manage"]),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    },
    source: "api",
    requestId: "budget-cell-scope-test",
    apiKeyId: null,
  } as unknown as ApplicationContext;
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"budgets":true}'::jsonb, true
        ) where id = ${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden budget entity', 'CAD', 'CA')`);
      await db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
        values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Mixed entity scenario', 'budget', 'draft')`);
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${hidden}, '100.0000')`);
    });

    await withOrgContext(org.orgId, async () => {
      await assert.rejects(
        updateBudgetCells(context, {
          scenarioId,
          expectedRevision: 1,
          cells: [
            {
              accountId: org.accounts.cogs,
              periodId: org.periodId,
              subsidiaryId: org.subsidiaryId,
              amount: "250.0000",
            },
          ],
          idempotencyKey: "budget-cell-scope-01",
        }),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === "forbidden" &&
          error.status === 403 &&
          /Hidden budget entity/.test(error.message),
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
