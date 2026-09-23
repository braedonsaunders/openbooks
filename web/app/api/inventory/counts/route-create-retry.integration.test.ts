import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __stockCountRetryAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__stockCountRetryAudit.user,allowedSubsidiaryIds:null}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

/**
 * IN9: a committed count create whose response is lost, retried with the
 * same key and payload, must return the ORIGINAL count id — exactly one
 * stock_counts row, no duplicate.
 */
test("a committed count create retried with the same key returns the original count", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    const { POST } = await import("./route");
    const body = { action: "create", idempotencyKey: randomUUID(), locationId: org.locationId,
      subsidiaryId: org.subsidiaryId, date: org.date,
      lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] };
    const post = () => new Request("http://audit.local/api/inventory/counts", { method: "POST", body: JSON.stringify(body) });
    // The create commits; the response never reaches the operator.
    const first = await POST(post());
    const result = await first.json();
    assert.equal(first.status, 200, JSON.stringify(result));
    assert.equal(result.replayed, false);
    assert.ok(typeof result.id === "string" && result.id.length > 0, "the create must return the count id");
    // The operator presses Open count again with unchanged fields.
    const retry = await POST(post());
    const replay = await retry.json();
    assert.equal(retry.status, 200, JSON.stringify(replay));
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.equal(replay.id, result.id, "the retry must return the ORIGINAL count id");
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from stock_counts where org_id=${org.orgId}`)).rows[0]!.n,
      1, "the retry must replay, not open a second count",
    );
  } finally { await dropScratchOrg(org.orgId); }
});
