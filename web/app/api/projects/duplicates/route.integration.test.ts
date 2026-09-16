import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-PostgreSQL regression for the project duplicates/merge routes: the
// list surfaces every duplicate key, preview reports the impact, commit
// merges with audit evidence, and validation fails closed.
const stateKey = Symbol.for("openbooks.project-merge-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.project-merge-route-test')]
  export async function guardPermission() {
    if (!state.authz) return new Response(null, { status: 401 })
    return state.authz
  }
  export function guardSubsidiaryScope() { return null }
  export async function guardProjectsFeature() { return null }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      (specifier === "../../../../lib/authz" || specifier === "../../../../lib/projects-gate")
      && (context.parentURL?.includes("projects/duplicates") || context.parentURL?.includes("projects/merge"))
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const parentDir = decodeURIComponent(
        new URL(".", context.parentURL).href,
      );
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot !== -1) {
        return nextResolve(
          new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts")
            .href,
          context,
        );
      }
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      const webMarker = context.parentURL?.lastIndexOf("/web/") ?? -1;
      if (webMarker === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(
          `${context.parentURL!.slice(0, webMarker + 1)}engine/${specifier.slice("@openbooks/engine/".length)}`,
        ).href,
        context,
      );
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

const duplicatesUrl = "./route.ts?project-duplicates-route-test";
const mergeUrl = "../merge/route.ts?project-merge-route-test";
const { GET: listDuplicates } = (await import(duplicatesUrl)) as typeof import("./route.ts");
const { GET: previewMerge, POST: commitMerge } =
  (await import(mergeUrl)) as typeof import("../merge/route.ts");
hooks.deregister();

const { db } = await import("../../../../../engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("../../../../../engine/src/test-fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function authorize(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    allowedSubsidiaryIds: null,
  };
}

async function enableProjects(orgId: string): Promise<void> {
  await db.execute(sql`update orgs set settings=jsonb_set(settings, '{features}',
    coalesce(settings->'features','{}') || '{"projects":true}'::jsonb) where id=${orgId}`);
}

async function seedProject(
  orgId: string,
  subsidiaryId: string,
  customerId: string,
  code: string,
  custom: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${id}, ${orgId}, ${subsidiaryId}, ${code}, ${code}, ${customerId},
            'active', true, ${JSON.stringify(custom)}::jsonb)`);
  return id;
}

test("project duplicates list, preview, and merge through the routes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    authorize(org.orgId, actor);
    await enableProjects(org.orgId);
    const survivor = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-R", {
      source: { system: "other", externalId: "7" },
      nsId: "7",
    });
    const duplicate = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-R", {
      nsId: "7",
    });

    const listRes = await listDuplicates();
    assert.equal(listRes.status, 200);
    const listed = (await listRes.json()) as {
      groups: { kind: string; projects: { id: string }[] }[];
    };
    assert.ok(
      listed.groups.some(
        (group) =>
          group.kind === "job_number"
          && group.projects.some((p) => p.id === duplicate)
          && group.projects.some((p) => p.id === survivor),
      ),
    );

    const previewRes = await previewMerge(
      new Request(
        `http://openbooks.test/api/projects/merge?survivorId=${survivor}&duplicateId=${duplicate}`,
      ),
    );
    assert.equal(previewRes.status, 200);
    const preview = (await previewRes.json()) as { alreadyMerged: boolean };
    assert.equal(preview.alreadyMerged, false);

    const commitRes = await commitMerge(
      new Request("http://openbooks.test/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId: survivor, duplicateId: duplicate }),
      }),
    );
    assert.equal(commitRes.status, 200);
    const committed = (await commitRes.json()) as { alreadyMerged: boolean; auditId: string | null };
    assert.equal(committed.alreadyMerged, false);
    assert.ok(committed.auditId);

    const relistRes = await listDuplicates();
    const relisted = (await relistRes.json()) as {
      groups: { kind: string; projects: { id: string }[] }[];
    };
    assert.ok(
      !relisted.groups.some((group) => group.projects.some((p) => p.id === duplicate)),
      "merged project leaves every duplicate group",
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("project merge route validates input and maps refusals", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    authorize(org.orgId, actor);
    await enableProjects(org.orgId);
    const badPreview = await previewMerge(
      new Request("http://openbooks.test/api/projects/merge?survivorId=nope&duplicateId=nope"),
    );
    assert.equal(badPreview.status, 400);
    const unknown = await commitMerge(
      new Request("http://openbooks.test/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId: randomUUID(), duplicateId: randomUUID() }),
      }),
    );
    assert.equal(unknown.status, 404);
    const a = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-V", {});
    const b = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-V", {});
    const c = await seedProject(org.orgId, org.subsidiaryId, org.customerId, "JOB-V", {});
    const first = await commitMerge(
      new Request("http://openbooks.test/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId: a, duplicateId: b }),
      }),
    );
    assert.equal(first.status, 200);
    const spent = await commitMerge(
      new Request("http://openbooks.test/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId: c, duplicateId: b }),
      }),
    );
    assert.equal(spent.status, 422);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
