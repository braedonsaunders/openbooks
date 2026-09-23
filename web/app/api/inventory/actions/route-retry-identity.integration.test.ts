import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { withSimClock } from "@openbooks/engine/src/platform/clock.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __inventoryRetryAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__inventoryRetryAudit.user,allowedSubsidiaryIds:null}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

/**
 * IN8: a committed inventory Post whose response is lost, retried after a
 * business-date rollover, must replay the original posting — exactly one
 * movement and one journal, no conflict. The drawer freezes the posting date
 * in the first payload, so the retry hashes identically; replaying the same
 * key with the server filling a NEW date would 409 instead.
 */
test("a committed receipt retried after midnight replays with one movement and one journal", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    const { POST } = await import("./route");
    const key = randomUUID();
    // The drawer freezes the server business day in the FIRST payload.
    const body = { action: "receive", idempotencyKey: key, itemId: org.items.fifo,
      stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: "2026-07-15",
      quantity: "5", unitCost: "10", offsetAccountId: org.accounts.clearing };
    const post = () => new Request("http://audit.local/api/inventory/actions", { method: "POST", body: JSON.stringify(body) });
    // Committed at 23:59; the response never reaches the operator.
    const first = await withSimClock("2026-07-15T23:59:00Z", () => POST(post()));
    const result = await first.json();
    assert.equal(first.status, 200, JSON.stringify(result));
    assert.equal(result.replayed, false);
    // The operator presses Post again after midnight. The payload still
    // carries the frozen date, so the key replays the stored result.
    const retry = await withSimClock("2026-07-16T00:05:00Z", () => POST(post()));
    const replay = await retry.json();
    assert.equal(retry.status, 200, JSON.stringify(replay));
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n,
      1, "the retry must replay, not post a second movement",
    );
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n,
      1, "the retry must replay, not post a second journal",
    );
    // Mechanism guard: the SAME key retried with the date left for the
    // server to fill after the rollover hashes differently and conflicts —
    // exactly why the drawer freezes the date in the first payload.
    const unfrozen = { ...body, date: undefined };
    delete (unfrozen as Record<string, unknown>).date;
    const conflict = await withSimClock("2026-07-16T00:05:00Z", () =>
      POST(new Request("http://audit.local/api/inventory/actions", { method: "POST", body: JSON.stringify(unfrozen) })));
    assert.equal(conflict.status, 409, JSON.stringify(await conflict.json()));
  } finally { await dropScratchOrg(org.orgId); }
});
