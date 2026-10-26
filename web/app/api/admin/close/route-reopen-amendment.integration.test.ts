import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { stubModules, withAuthzTestSurface } from "../../../../testing/stub-modules";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __closeAmendmentRouteUser: state });
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface(
      "export async function guardPermission(){return {user:globalThis.__closeAmendmentRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}} export function guardSubsidiaryScope(){return null}",
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
const { setPeriodLockState } = await import("@openbooks/engine/periods/period-locks");
const request = (body: unknown) =>
  new Request("http://close.local/api/admin/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("zero additional hours submits module widening as a new request without changing the approved window", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    state.user = { orgId: org.orgId, id: actors.adminId };
    const source = await withBypassContext(async () => {
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
      };
      for (const module of ["gl", "ap"] as const) {
        await setPeriodLockState({
          ...target,
          module,
          state: "closed",
          actorId: actors.adminId,
          reason: "Close for review",
        });
      }
      const id = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        reason: "Correction window",
        actorId: actors.adminId,
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: id,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      return id;
    });
    const body = {
      action: "extend-reopen",
      requestId: source,
      reason: "Include AP without extending time",
      addModules: ["ap"],
      additionalHours: 0,
    };
    for (const hours of [-1, 0.5, 169]) {
      const refused = await withOrgContext(org.orgId, () =>
        POST(request({ ...body, additionalHours: hours })),
      );
      assert.equal(refused.status, 422, await refused.text());
    }
    const response = await withOrgContext(org.orgId, () => POST(request(body)));
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      requestId: string;
      expiresAt: string;
    };
    assert.notEqual(result.requestId, source);
    const requests = await withBypassContext(() =>
      db.execute<{
        id: string;
        status: string;
        modules: string[];
        expires_at: Date | null;
      }>(
        sql`
      select id, status, modules, expires_at from close_reopen_requests where org_id = ${org.orgId}`,
        "objects",
      ),
    );
    assert.equal(requests.length, 2);
    const original = requests.find((row) => row.id === source)!;
    const amendment = requests.find((row) => row.id === result.requestId)!;
    assert.equal(original.status, "approved");
    assert.deepEqual(original.modules, ["gl"]);
    assert.equal(result.expiresAt, new Date(original.expires_at!).toISOString());
    assert.equal(amendment.status, "requested");
    assert.deepEqual(amendment.modules, ["gl", "ap"]);
    assert.equal(amendment.expires_at, null);
  } finally {
    state.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
