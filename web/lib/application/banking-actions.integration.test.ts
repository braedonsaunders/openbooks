import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Banking actions (start/match/unmatch/sign-off) terminate in the engine and
// banking-rules services the routes call. This suite drives the full session
// lifecycle through executeApplicationTool: happy path, idempotent replay,
// permission refusal, subsidiary restriction, feature-off, and cross-org
// isolation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(
  orgId: string,
  userId: string,
  permissions: string[],
  allowedSubsidiaryIds: Set<string> | null = null,
): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId, email: `${userId}@test`, name: "Test", orgId,
        roles: [{ key: "banking-role", name: "Banking role" }],
        envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
        homeUserId: userId, homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function seedSession(orgId: string, subsidiaryId: string, bankId: string, revenueId: string, actorId: string) {
  return withBypassContext(async () => {
  await db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD', subsidiary_id = ${subsidiaryId}
     where id in (${bankId}, ${revenueId}) and org_id = ${orgId}
  `);
  const statementId = randomUUID();
  await db.execute(sql`
    insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
    values (${statementId}, ${orgId}, ${bankId}, 'tool-fixture', '2026-07-31', '1250.0000', 'tool-fixture.raw')
  `);
  const lineA = randomUUID();
  const lineB = randomUUID();
  for (const [id, n, amount] of [[lineA, 1, "1000.0000"], [lineB, 2, "250.0000"]] as const) {
    await db.execute(sql`
      insert into bank_statement_lines
        (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
      values (${id}, ${orgId}, ${statementId}, ${n}, '2026-07-15', ${amount}, 'CAD', 'Fixture transfer', 'unmatched', ${bankId})
    `);
  }
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, entry_number, posting_date, period_id, memo, status, origin, subsidiary_id)
    values (${entryId}, ${orgId},
      (select id from accounting_books where org_id = ${orgId} and is_primary),
      'JE-TOOL-1', '2026-07-15',
      (select id from accounting_periods where org_id = ${orgId} limit 1),
      'tool fixture', 'draft', 'manual', ${subsidiaryId})
  `);
  const glA = randomUUID();
  const glB = randomUUID();
  // Balanced posted entry: the bank debits are the match candidates, the
  // revenue credits balance it (the posted-balance trigger requires both).
  const legs: [string, number, string, string][] = [
    [glA, 1, bankId, "1000.0000"],
    [randomUUID(), 2, revenueId, "-1000.0000"],
    [glB, 3, bankId, "250.0000"],
    [randomUUID(), 4, revenueId, "-250.0000"],
  ];
  // One multi-row statement: the per-row balance trigger sees the whole set.
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
    values ${sql.join(legs.map(([id, n, accountId, amount]) => sql`(${id}, ${orgId}, ${entryId}, ${n}, ${accountId}, ${amount}, 'CAD', ${amount}, ${subsidiaryId})`), sql`, `)}
  `);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
     where id = ${entryId} and org_id = ${orgId}
  `);
  return { lineA, lineB, glA, glB };
  });
}

async function reconStatus(orgId: string, reconId: string): Promise<string | null> {
  return withOrgContext(orgId, async () => {
  const rows = (await db.execute<{ status: string }>(sql`
    select status from reconciliations where id = ${reconId} and org_id = ${orgId}
  `)).rows;
  return rows[0]?.status ?? null;
  });
}

test("banking session lifecycle: start, match, unmatch, rematch, sign off", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const ids = await seedSession(org.orgId, org.subsidiaryId, org.accounts.bank, org.accounts.revenue, actors.adminId);
    const ctx = ctxFor(org.orgId, actors.adminId, ["banking.reconcile"]);
    // The tools read through ambient org scope (production: request). Scope
    // every call to the caller's org so the permission/subsidiary/module
    // gates under test run instead of the RLS backstop.
    const run = (name: string, input: Record<string, unknown>) =>
      withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));

    const started = await run("start_reconciliation", {
      accountId: org.accounts.bank, throughDate: "2026-07-31", statementBalance: "1250.0000", idempotencyKey: "a05-start-1",
    }) as { replayed: boolean; result: { reconciliationId: string } };
    assert.equal(started.replayed, false);
    const reconId = started.result.reconciliationId;
    assert.equal(await reconStatus(org.orgId, reconId), "in_progress");

    const matched = await run("match_bank_line", {
      reconciliationId: reconId, statementLineId: ids.lineA, journalLineIds: [ids.glA], idempotencyKey: "a05-match-a",
    }) as { result: { totals: { difference: string } } };
    assert.equal(matched.result.totals.difference, "250.0000");

    const unmatched = await run("unmatch_bank_line", {
      reconciliationId: reconId, statementLineId: ids.lineA, idempotencyKey: "a05-unmatch-a",
    }) as { result: { totals: { difference: string } } };
    assert.equal(unmatched.result.totals.difference, "1250.0000");

    await run("match_bank_line", {
      reconciliationId: reconId, statementLineId: ids.lineA, journalLineIds: [ids.glA], idempotencyKey: "a05-match-a2",
    });
    await run("match_bank_line", {
      reconciliationId: reconId, statementLineId: ids.lineB, journalLineIds: [ids.glB], idempotencyKey: "a05-match-b",
    });
    const signed = await run("sign_off_reconciliation", { reconciliationId: reconId, idempotencyKey: "a05-sign-1" }) as {
      replayed: boolean; result: { journalLinesReconciled: number };
    };
    assert.equal(signed.replayed, false);
    assert.equal(signed.result.journalLinesReconciled, 2);
    assert.equal(await reconStatus(org.orgId, reconId), "signed_off");

    // Replaying the exact sign-off command replays instead of erroring on the
    // now-signed-off session.
    const replayed = await run("sign_off_reconciliation", { reconciliationId: reconId, idempotencyKey: "a05-sign-1" }) as {
      replayed: boolean; result: { journalLinesReconciled: number };
    };
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.result.journalLinesReconciled, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("banking actions refuse without permission, outside subsidiary scope, or with the module off", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    await seedSession(org.orgId, org.subsidiaryId, org.accounts.bank, org.accounts.revenue, actors.adminId);
    const stranger = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${stranger}, ${org.orgId}, ${org.subsidiaryId}, 'Stranger Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `));
    const full = ctxFor(org.orgId, actors.adminId, ["banking.reconcile"]);
    const started = await withOrgContext(org.orgId, () => executeApplicationTool(applicationTool("start_reconciliation")!, full, {
      accountId: org.accounts.bank, throughDate: "2026-07-31", statementBalance: "1250.0000", idempotencyKey: "a05-start-2",
    })) as { result: { reconciliationId: string } };

    // No banking.reconcile permission.
    await assert.rejects(
      withOrgContext(org.orgId, () => executeApplicationTool(applicationTool("start_reconciliation")!, ctxFor(org.orgId, actors.adminId, []), {
        accountId: org.accounts.bank, throughDate: "2026-07-31", statementBalance: "1250.0000", idempotencyKey: "a05-start-3",
      })),
      /forbidden/,
    );
    // Restricted to a subsidiary that does not own the account.
    await assert.rejects(
      withOrgContext(org.orgId, () => executeApplicationTool(
        applicationTool("match_bank_line")!,
        ctxFor(org.orgId, actors.adminId, ["banking.reconcile"], new Set([stranger])),
        { reconciliationId: started.result.reconciliationId, statementLineId: randomUUID(), journalLineIds: [randomUUID()], idempotencyKey: "a05-scope-01" },
      )),
      /forbidden/,
    );
    // Module off: the execute-time fence matches the routes' 404.
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"banking":false}'::jsonb, true)
      where id = ${org.orgId}
    `));
    try {
      await assert.rejects(
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool("start_reconciliation")!, full, {
          accountId: org.accounts.bank, throughDate: "2026-07-31", statementBalance: "1250.0000", idempotencyKey: "a05-start-4",
        })),
        /banking not found/,
      );
    } finally {
      await withBypassContext(() => db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"banking":true}'::jsonb, true)
        where id = ${org.orgId}
      `));
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("banking actions in another org read as missing", { skip: !DB }, async () => {
  const first = await withBypassContext(() => createScratchOrg());
  const second = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(first.orgId));
    await seedSession(first.orgId, first.subsidiaryId, first.accounts.bank, first.accounts.revenue, actors.adminId);
    const full = ctxFor(first.orgId, actors.adminId, ["banking.reconcile"]);
    const started = await withOrgContext(first.orgId, () => executeApplicationTool(applicationTool("start_reconciliation")!, full, {
      accountId: first.accounts.bank, throughDate: "2026-07-31", statementBalance: "1250.0000", idempotencyKey: "a05-start-5",
    })) as { result: { reconciliationId: string } };
    const otherActors = await withBypassContext(() => seedFlowActors(second.orgId));
    const other = ctxFor(second.orgId, otherActors.adminId, ["banking.reconcile"]);
    // Scoped to the session's own org on purpose: the row stays RLS-visible
    // so the refusal comes from the tool's cross-org check, not the backstop.
    await assert.rejects(
      withOrgContext(first.orgId, () => executeApplicationTool(applicationTool("sign_off_reconciliation")!, other, {
        reconciliationId: started.result.reconciliationId, idempotencyKey: "a05-cross-02",
      })),
      /reconciliation not found/,
    );
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});
