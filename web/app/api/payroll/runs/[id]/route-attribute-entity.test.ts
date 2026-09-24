import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { env } from "@openbooks/engine/src/platform/db.ts";

/**
 * POST attribute-entity — the remedy the remittance refusal names.
 *
 * Real route, real engine, real database; only the authz seam is mocked
 * (the same seam every subsidiary-scope route test uses). No engine or
 * database double stands in for the behavior under test, so a refusal here
 * is the production refusal, not a mock's echo:
 *
 *   - an unrestricted caller attributes a legacy entityless run and the
 *     header moves null → target with nothing rewritten (reclassedLines 0);
 *   - a restricted caller meets the same 404 a missing run answers, and
 *     the denial writes nothing;
 *   - a malformed target, a non-committed run, and a re-attribution each
 *     refuse by name with the run untouched.
 */

const stateKey = Symbol.for("openbooks.payroll-run-attribute-entity-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.payroll-run-attribute-entity-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

// This file lives at web/app/api/payroll/runs/[id]/ — five levels up is web/.
const webRoot = new URL("../../../../../", import.meta.url);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`.${specifier.slice(1)}.ts`, webRoot).href, context);
    }
    if (specifier.endsWith("/lib/feature-gates")) {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Fresh module instances via a query string, with the mock seam active only
// for these imports.
const runUrl = "./route.ts?payroll-run-attribute-entity";
const { POST: postRun } = (await import(runUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts");

// Production scopes every route read through the request org; the mocked
// authz stands in for the request here, so each route call runs inside the
// mocked caller's org boundary.
function scoped<T>(fn: () => Promise<T>): Promise<T> {
  const authz = routeState.authz;
  assert.ok(authz, "route helpers require an authenticated caller");
  return withOrgContext(authz.user.orgId, fn);
}

function attribute(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return scoped(() =>
    postRun(
      new Request(`http://openbooks.test/api/payroll/runs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function docSubsidiary(orgId: string, documentId: string): Promise<string | null> {
  const row = (
    await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id::text as subsidiary_id from documents
       where org_id = ${orgId} and id = ${documentId}`)
  ).rows[0];
  return row?.subsidiary_id ?? null;
}

test(
  "attribute-entity attributes, scopes, and refuses by name",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const orgId = org.orgId;
    const rootId = org.subsidiaryId;
    try {
      const actors = await withBypass(() => seedFlowActors(orgId));
      const adminId = actors.adminId;
      const restrictedId = actors.submitterId;

      const { runDocumentId, scopedDocumentId, draftDocumentId, otherId } =
        await withBypass(async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ payroll: true })}::jsonb)
           where id = ${orgId}`);
        // A second entity so the restricted caller has somewhere to stand.
        const otherId = randomUUID();
        await db.execute(sql`
          insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, is_elimination, is_active, custom)
          values (${otherId}, ${orgId}, 'Entity B', 'USD', 'US', ${rootId}, false, true, '{}'::jsonb)`);
        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules (org_id, id, name, frequency, periods_per_year,
                                     anchor_period_end, pay_date_offset_days, subsidiary_id)
          values (${orgId}, ${scheduleId}, 'Legacy schedule', 'monthly', 12, '2026-07-31', 0, ${rootId})`);
        // Legacy shape: committed, but the document carries no entity.
        const makeEntitylessCommitted = async (): Promise<string> => {
          const run = await createPayRun({ orgId, actorId: adminId, payScheduleId: scheduleId });
          await db.execute(sql`
            update documents set subsidiary_id = null
             where org_id = ${orgId} and id = ${run.documentId}`);
          await db.execute(sql`
            update pay_runs set run_status = 'committed'
             where org_id = ${orgId} and document_id = ${run.documentId}`);
          return run.documentId;
        };
        const runDocumentId = await makeEntitylessCommitted();
        const scopedDocumentId = await makeEntitylessCommitted();
        const draft = await createPayRun({ orgId, actorId: adminId, payScheduleId: scheduleId });
        return { runDocumentId, scopedDocumentId, draftDocumentId: draft.documentId, otherId };
      });

      // An unrestricted caller attributes the legacy run to the root.
      routeState.authz = {
        user: { orgId, id: adminId },
        permissions: new Set(["payroll.run"]),
        allowedSubsidiaryIds: null,
      };
      const attributed = await attribute(runDocumentId, {
        action: "attribute-entity",
        subsidiaryId: rootId,
      });
      assert.equal(attributed.status, 200);
      const attributedBody = (await attributed.json()) as Record<string, unknown>;
      assert.equal(attributedBody.ok, true);
      assert.equal(attributedBody.reclassedLines, 0);
      assert.equal(await docSubsidiary(orgId, runDocumentId), rootId);

      // A malformed target refuses before anything moves.
      const malformed = await attribute(runDocumentId, {
        action: "attribute-entity",
        subsidiaryId: "not-a-subsidiary",
      });
      assert.equal(malformed.status, 422);
      assert.match(
        ((await malformed.json()) as { error: string }).error,
        /choose a subsidiary/,
      );

      // A draft run is edited, not attributed.
      const draftRefused = await attribute(draftDocumentId, {
        action: "attribute-entity",
        subsidiaryId: rootId,
      });
      assert.equal(draftRefused.status, 422);
      assert.match(
        ((await draftRefused.json()) as { error: string }).error,
        /not committed/,
      );
      // Untouched: still the schedule-stamped root, still a draft.
      assert.equal(await docSubsidiary(orgId, draftDocumentId), rootId);

      // Re-attribution would move live books between entities.
      const reRefused = await attribute(runDocumentId, {
        action: "attribute-entity",
        subsidiaryId: rootId,
      });
      assert.equal(reRefused.status, 422);
      assert.match(
        ((await reRefused.json()) as { error: string }).error,
        /already attributed/,
      );

      // A restricted caller meets the missing-run 404 on the entityless
      // run — indistinguishable, and the denial writes nothing.
      routeState.authz = {
        user: { orgId, id: restrictedId },
        permissions: new Set(["payroll.run"]),
        allowedSubsidiaryIds: new Set([otherId]),
      };
      const scoped = await attribute(scopedDocumentId, {
        action: "attribute-entity",
        subsidiaryId: otherId,
      });
      assert.equal(scoped.status, 404);
      assert.deepEqual(await scoped.json(), { error: "not found" });
      assert.equal(await docSubsidiary(orgId, scopedDocumentId), null);
    } finally {
      routeState.authz = null;
      await withBypass(() => dropScratchOrg(orgId));
    }
  },
);
