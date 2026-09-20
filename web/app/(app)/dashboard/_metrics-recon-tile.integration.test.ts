import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The recon tile reads bankingHome.unmatchedLines — the same reader as the
// /banking cockpit and its Match-button count — never a parallel count.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Recon Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["dashboard.read", ...permissions]),
    allowedSubsidiaryIds: null,
  };
}

async function seedStatement(org: ScratchOrg, unmatched: number, matched: number): Promise<void> {
  await db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  const statementId = randomUUID();
  await db.execute(sql`
    insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
    values (${statementId}, ${org.orgId}, ${org.accounts.bank}, 'tile-fixture', '2026-07-31', '1250.0000', 'tile-fixture.raw')
  `);
  let n = 0;
  const lines: Array<[string, string]> = [];
  for (let i = 0; i < unmatched; i++) lines.push([randomUUID(), "unmatched"]);
  for (let i = 0; i < matched; i++) lines.push([randomUUID(), "matched"]);
  for (const [id, status] of lines) {
    n += 1;
    await db.execute(sql`
      insert into bank_statement_lines
        (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
      values (${id}, ${org.orgId}, ${statementId}, ${n}, '2026-07-15', '100.0000', 'CAD', 'Tile fixture', ${status}, ${org.accounts.bank})
    `);
  }
}

test("dashboard recon tile counts unmatched statement lines through the cockpit reader", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(() => seedStatement(org, 2, 1));
    const actor = await withBypass(() => createScratchUser(org.orgId, "Recon Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["banking.read"])),
    );
    assert.equal(metrics.unreconciledItems, 2, "matched lines do not count");
    // A caller without banking.read sees zero — and loadReconSummary proves
    // separately (no-DB unit test) that the reader is never called for them.
    const blind = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["gl.read"])),
    );
    assert.equal(blind.unreconciledItems, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("dashboard recon tile is honest on empty: zero items, not a missing tile", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Recon Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["banking.read"])),
    );
    assert.equal(metrics.unreconciledItems, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
