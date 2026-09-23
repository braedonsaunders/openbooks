import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// OM-17: the hrm-review-templates New drawer crashed before it could save,
// so the whole create path for rating-scale labels went unexercised. This
// proves the setup writer persists a review template created with
// rating-scale labels and reads the folded scale back — create, read,
// label edit, read again.
const stateKey = Symbol.for("openbooks.hrm-review-template-labels-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.hrm-review-template-labels-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const entityRoute = context.parentURL?.includes("%5Bentity%5D") ?? context.parentURL?.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && entityRoute) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?hrm-review-template-labels-route-test";
const { PATCH, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

function authenticate(f: { orgId: string; actorId: string }) {
  routeState.authz = {
    user: { orgId: f.orgId, id: f.actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function postRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });
}

const call = (entity: string) => ({ params: Promise.resolve({ entity }) });

async function scaleOf(id: string): Promise<{ name: string; scale: { min: unknown; max: unknown; labels: unknown } }> {
  const rows = (
    await db.execute<{ name: string; scale: { min: unknown; max: unknown; labels: unknown } }>(sql`
      select name, rating_scale as scale from hrm_review_templates where id = ${id}`)
  ).rows;
  assert.equal(rows.length, 1, "the created template must read back exactly once");
  return rows[0]!;
}

test("a review template created with rating-scale labels persists and reads back", async () => {
  // The drawer edits the scale as three structured fields (min, max, labels)
  // and the writer folds them into rating_scale before buildRow: the labels
  // the TagInput collects must survive the fold to storage and back.
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Review Admin", "admin");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb)
     where id = ${org.orgId}`);
  authenticate({ orgId: org.orgId, actorId });

  const created = await POST(
    postRequest("hrm-review-templates", {
      name: "Annual review",
      ratingScaleMin: 1,
      ratingScaleMax: 5,
      ratingScaleLabels: ["Needs improvement", "Meets expectations", "Exceeds expectations"],
      isActive: true,
    }),
    call("hrm-review-templates"),
  );
  assert.equal(created.status, 200, JSON.stringify(await created.clone().json().catch(() => null)));
  const { id } = (await created.json()) as { id: string };

  const stored = await scaleOf(id);
  assert.equal(stored.name, "Annual review");
  assert.equal(String(stored.scale.min), "1");
  assert.equal(String(stored.scale.max), "5");
  assert.deepEqual(stored.scale.labels, ["Needs improvement", "Meets expectations", "Exceeds expectations"]);

  // A label edit keeps the untouched bounds: the edit path merges the stored
  // scale before the engine's own parseRatingScale proves it again. PATCH
  // carries full bodies (the drawer contract), like every other setup edit.
  const patched = await PATCH(
    new Request("http://localhost/api/admin/setup/hrm-review-templates", {
      method: "PATCH",
      body: JSON.stringify({
        id,
        name: "Annual review",
        ratingScaleMin: 1,
        ratingScaleMax: 5,
        ratingScaleLabels: ["Low", "High"],
        isActive: true,
      }),
    }),
    call("hrm-review-templates"),
  );
  assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json().catch(() => null)));
  const edited = await scaleOf(id);
  assert.deepEqual(edited.scale.labels, ["Low", "High"]);
  assert.equal(String(edited.scale.min), "1");
  assert.equal(String(edited.scale.max), "5");
});
