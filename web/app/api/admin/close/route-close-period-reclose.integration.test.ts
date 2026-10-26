import assert from "node:assert/strict";
import { stubModules, withAuthzTestSurface } from "../../../../testing/stub-modules";
import test from "node:test";
import { sql } from "drizzle-orm";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeRecloseRouteUser: state });
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface(
      "export async function guardPermission(){return {user:globalThis.__closeRecloseRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
    ),
  },
  features: false,
});
const { POST } = await import("./route");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { requestReviewedReopenFixture, decideReopenFixture } =
  await import("@openbooks/engine/testing/close");
const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// December stands partially closed after an approved Banking + GL reopen:
// the Setup "Close period" submit must flip both back through the real
// route, audited — never answer ok with the locks still open.
test("close-period re-closes reopened modules through the route with audit", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    state.user = { orgId: org.orgId, id: actors.adminId };
    const closeAll = (reason: string) =>
      withOrgContext(org.orgId, () =>
        POST(
          request({
            action: "close-period",
            periodId: org.periodId,
            bookId: org.bookId,
            reason,
          }),
        ),
      );

    const first = await closeAll("December close control");
    assert.equal(first.status, 200, `first close: ${await first.text()}`);

    const requestId = await withBypassContext(() =>
      requestReviewedReopenFixture({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        modules: ["banking", "gl"],
        reason: "Banking corrections after the close",
        actorId: actors.adminId,
      }),
    );
    await withBypassContext(() =>
      decideReopenFixture({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      }),
    );

    const second = await closeAll("December re-close control");
    const body = (await second.json()) as {
      ok?: unknown;
      results?: { module: string; ok: boolean; error?: string }[];
    };
    assert.equal(second.status, 200, `re-close status: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, `re-close reports ok: ${JSON.stringify(body.results)}`);

    const states = await withBypassContext(() =>
      db.execute<{ module: string; state: string }>(
        sql`
      select module, state from period_locks
       where org_id = ${org.orgId} and period_id = ${org.periodId} and book_id = ${org.bookId}
         and subsidiary_id is null`,
        "objects",
      ),
    );
    const byModule = Object.fromEntries(states.map((row) => [row.module, row.state]));
    assert.equal(byModule.banking, "closed", "Banking stands closed again");
    assert.equal(byModule.gl, "closed", "General ledger stands closed again");
    const audits = await withBypassContext(() =>
      db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'period_locks' and action = 'update'
         and changes->'after'->>'state' = 'closed'`,
        "objects",
      ),
    );
    assert.ok(Number(audits[0]?.n ?? 0) >= 2, "both re-closed modules leave audit entries");
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
