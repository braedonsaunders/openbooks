import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A party drill lists the party's documents to any report reader. Expense
// reports among them follow expense read: an org-wide reader sees them, a
// self-service reader sees only their own, and a reader with report access
// alone sees the party's other documents only.
const stateKey = Symbol.for("openbooks.drill-expense-scope-test");
const routeState: { gate: unknown } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const virtual = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (
      resolved.url.endsWith("/web/lib/authz.ts") &&
      !(context.parentURL ?? "").startsWith("data:")
    ) {
      const nextServer = nextResolve("next/server", context).url;
      return virtual(`
        export * from ${JSON.stringify(resolved.url)};
        import { can } from ${JSON.stringify(resolved.url)};
        const state = globalThis[Symbol.for('openbooks.drill-expense-scope-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function getAuthz() { return state.gate }
        export async function guardPermission(permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          if (!can(state.gate, permission)) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
          return state.gate;
        }
      `);
    }
    return resolved;
  },
});

const { withBypassContext, withOrgContext, db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { GET } = await import("./route.ts");
const { EXPENSE_RESTRICTED_PARTY_LABEL } = await import("../../../../lib/expense-report-scope");
test.after(() => hooks.deregister());

test("a party drill shows expense reports only to readers who may read them", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const employee = randomUUID();
  const coworker = randomUUID();
  const self = await withBypassContext(() =>
    createScratchUser(org.orgId, "Riley Fieldworker", "drill_self"),
  );
  const other = await withBypassContext(() =>
    createScratchUser(org.orgId, "Sam Coworker", "drill_other"),
  );
  const analyst = await withBypassContext(() =>
    createScratchUser(org.orgId, "Report analyst", "drill_analyst"),
  );
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb),
               (${coworker}, ${org.orgId}, 'employee', 'Sam Coworker', true, '{}'::jsonb)`);
      await db.execute(
        sql`update users set party_id = ${employee} where id = ${self} and org_id = ${org.orgId}`,
      );
      await db.execute(
        sql`update users set party_id = ${coworker} where id = ${other} and org_id = ${org.orgId}`,
      );
      // The employee's posted expense report and a posted bill to the same party.
      for (const [kind, number, amount] of [
        ["expense_report", "EXP-DRILL-1", "40"],
        ["vendor_bill", "BILL-DRILL-1", "70"],
      ] as const) {
        const docId = randomUUID();
        const entryId = randomUUID();
        await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
          values (${docId}, ${org.orgId}, ${kind}, ${number}, ${org.date}, ${org.date}, ${employee}, ${org.subsidiaryId}, 'CAD', ${amount}, 0, ${amount}, '{}'::jsonb)`);
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${number}, ${org.date}, ${org.periodId}, 'draft', 'purchasing', ${docId})`);
        await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
          values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${employee}, false, ${amount}, 'CAD', ${amount}, 1, ${org.date}),
                 (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${employee}, true, -${amount}::numeric, 'CAD', -${amount}::numeric, 1, ${org.date})`);
        await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId}`);
        await db.execute(
          sql`update documents set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId} where id = ${docId}`,
        );
      }
    });
    const drill = async (userId: string, permissions: string[]) => {
      routeState.gate = {
        user: { orgId: org.orgId, id: userId, roles: [], isSuperAdmin: false },
        permissions: new Set(permissions),
        allowedSubsidiaryIds: null,
      };
      return withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(
            `http://drill.local/api/analytics/drill?party=${employee}&from=${org.date}&to=${org.date}`,
          ),
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          count: number;
          entries: Array<{ label: string }>;
          breakdown: Array<{ name: string }>;
        };
        return {
          count: body.count,
          labels: body.entries.map((entry) => entry.label).sort(),
          kinds: body.breakdown.map((row) => row.name).sort(),
        };
      });
    };

    assert.deepEqual(
      await drill(analyst, ["reports.read"]),
      { count: 1, labels: ["BILL-DRILL-1"], kinds: ["vendor_bill"] },
      "report read alone reaches no expense report, in the list or the totals",
    );
    assert.deepEqual(await drill(analyst, ["reports.read", "expenses.read"]), {
      count: 2,
      labels: ["BILL-DRILL-1", "EXP-DRILL-1"],
      kinds: ["expense_report", "vendor_bill"],
    });
    assert.deepEqual(
      await drill(self, ["reports.read", "expenses.self"]),
      {
        count: 2,
        labels: ["BILL-DRILL-1", "EXP-DRILL-1"],
        kinds: ["expense_report", "vendor_bill"],
      },
      "a self-service reader sees their own expense report",
    );
    assert.deepEqual(
      await drill(other, ["reports.read", "expenses.self"]),
      { count: 1, labels: ["BILL-DRILL-1"], kinds: ["vendor_bill"] },
      "another employee's expense report stays out of a self-service reader's drill",
    );

    // An account drill keeps every leg's amount, so the account still ties,
    // but a leg of an unreadable expense report names no employee, memo or report.
    const accountDrill = async (userId: string, permissions: string[]) => {
      routeState.gate = {
        user: { orgId: org.orgId, id: userId, roles: [], isSuperAdmin: false },
        permissions: new Set(permissions),
        allowedSubsidiaryIds: null,
      };
      return withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(
            `http://drill.local/api/analytics/drill?account=${org.accounts.cogs}&from=${org.date}&to=${org.date}`,
          ),
        );
        assert.equal(response.status, 200);
        return (await response.json()) as {
          total: string;
          count: number;
          entries: Array<{ label: string; docId: string | null; docNumber: string }>;
          breakdown: Array<{ name: string; amount: string }>;
        };
      });
    };
    const full = await accountDrill(analyst, ["reports.read", "expenses.read"]);
    assert.deepEqual(full.entries.map((entry) => entry.docNumber).sort(), [
      "BILL-DRILL-1",
      "EXP-DRILL-1",
    ]);
    const restricted = await accountDrill(analyst, ["reports.read"]);
    assert.equal(restricted.total, full.total, "the account total is unchanged");
    assert.equal(restricted.count, full.count);
    assert.equal(
      JSON.stringify(restricted).includes("EXP-DRILL-1"),
      false,
      "the report is not referenced",
    );
    const masked = restricted.entries.find(
      (entry) => entry.label === EXPENSE_RESTRICTED_PARTY_LABEL,
    );
    assert.ok(masked, "the expense leg is shown under the restricted label");
    assert.equal(masked.docId, null);
    assert.deepEqual(
      restricted.breakdown.map((row) => row.name).sort(),
      [EXPENSE_RESTRICTED_PARTY_LABEL, "Riley Fieldworker"].sort(),
      "the bill to the same person keeps its party; the expense leg does not",
    );
    const own = await accountDrill(self, ["reports.read", "expenses.self"]);
    assert.deepEqual(
      own.entries.map((entry) => entry.docNumber).sort(),
      ["BILL-DRILL-1", "EXP-DRILL-1"],
      "a self-service reader sees their own report leg",
    );
  } finally {
    routeState.gate = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
