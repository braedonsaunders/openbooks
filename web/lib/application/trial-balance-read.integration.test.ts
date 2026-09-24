import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { listApplicationTrialBalance } = await import("./trial-balance-read");
type ApplicationContext = import("./context").ApplicationContext;

test("application trial balance returns exact ledger amounts through the report reader", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const entryId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, origin, status, memo)
        values (${entryId}, ${org.orgId}, ${org.bookId}, 'T1-TB-EXACT', ${org.date}, ${org.periodId},
                ${org.subsidiaryId}, 'manual', 'draft', 'trial balance precision fixture')`);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, amount, txn_amount, currency, subsidiary_id, posting_date)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, '1234.5678', '1234.5678', 'CAD', ${org.subsidiaryId}, ${org.date}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, '-1234.5678', '-1234.5678', 'CAD', ${org.subsidiaryId}, ${org.date})`);
      await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    });
    const context: ApplicationContext = {
      authz: {
        user: { orgId: org.orgId, id: randomUUID() } as ApplicationContext["authz"]["user"],
        permissions: new Set(["reports.read"]),
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      },
      source: "api",
      requestId: randomUUID(),
      apiKeyId: null,
    };

    const result = await withOrgContext(org.orgId, () => listApplicationTrialBalance(context, { asOf: org.date }));
    const bank = (await withOrgContext(org.orgId, () => db.execute<{ number: string | null; name: string; type: string }>(sql`
      select number, name, type from accounts where id = ${org.accounts.bank} and org_id = ${org.orgId}`))).rows[0]!;
    const bankRow = result.accounts.find((row) => row.number === bank.number && row.name === bank.name);

    assert.ok(bankRow, "the posted bank ledger activity is visible in the trial balance");
    assert.deepEqual(bankRow, {
      number: bank.number,
      name: bank.name,
      type: bank.type,
      debits: "1234.5678",
      credits: "0.0000",
      balance: "1234.5678",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
