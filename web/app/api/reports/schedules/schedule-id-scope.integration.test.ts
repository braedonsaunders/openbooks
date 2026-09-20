import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Schedule routes: a malformed schedule id must be a clean 404 (never a
 * Postgres uuid cast error surfacing as a 500) on autosave and delete — the
 * same boundary the definition, run-download, view, and journal routes keep.
 *
 * PATCH must also keep the stored authorization_snapshot. An org-unrestricted
 * editor who canAccessReportArtifact of a narrower pin must not persist
 * allowedSubsidiaryIds: null over that pin.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const defaultGate = {
  user: { orgId: "org-1", id: "user-1" },
  permissions: ["reports.schedule"],
  allowedSubsidiaryIds: null as string[] | null,
};
const gate = { ...defaultGate, user: { ...defaultGate.user } };
Object.assign(globalThis, { __scheduleIdScopeGate: gate });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/schedules/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              const g = globalThis.__scheduleIdScopeGate;
              return {
                user: g.user,
                permissions: new Set(g.permissions),
                allowedSubsidiaryIds: g.allowedSubsidiaryIds === null ? null : new Set(g.allowedSubsidiaryIds),
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { PATCH, DELETE } = await import("./[id]/route.ts");

function resetGate(): void {
  gate.user = { ...defaultGate.user };
  gate.permissions = [...defaultGate.permissions];
  gate.allowedSubsidiaryIds = defaultGate.allowedSubsidiaryIds;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/reports/schedules", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("schedule autosave and delete answer a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  resetGate();
  for (const id of ["not-a-uuid", "new"]) {
    // NOTE: no fixture row is needed — the uuid cast fails before any row
    // could resolve, which is exactly the defect.
    const patched = await PATCH(json("PATCH", { active: false }), params(id));
    assert.equal(patched.status, 404, `PATCH ${id}`);
    assert.deepEqual(await patched.json(), { error: "not found" });

    const deleted = await DELETE(json("DELETE", {}), params(id));
    assert.equal(deleted.status, 404, `DELETE ${id}`);
    assert.deepEqual(await deleted.json(), { error: "not found" });
  }
});

test("hour/active PATCH keeps a restricted authorization_snapshot when the editor is org-unrestricted", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { db, withBypassContext } = await import(root + "engine/src/platform/db.ts");
  const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
  const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
    root + "engine/src/testing/fixtures.ts"
  );
  const fixture = await withBypassContext(() => createScratchOrg());
  const oid = fixture.orgId;
  try {
    const editorId = await withBypassContext(() =>
      createScratchUser(oid, "Unrestricted schedule editor", "schedule_editor"),
    );
    const definitionId = randomUUID();
    const scheduleId = randomUUID();
    const pin = {
      version: 1 as const,
      userId: editorId,
      allowedSubsidiaryIds: [fixture.subsidiaryId],
      definition: {
        report_type: "query" as const,
        query: { entity: "documents", columns: ["document_number"] },
        statement: null,
        name: "Pinned delivery",
        slug: "pinned-delivery",
        kind: "custom",
      },
    };
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into report_definitions (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
        values (${definitionId}, ${oid}, 'custom', 'query', ${pin.definition.slug}, ${pin.definition.name},
                ${JSON.stringify(pin.definition.query)}::jsonb, ${editorId}, ${editorId})
      `);
      await db.execute(sql`
        insert into report_schedules
          (id, org_id, definition_id, cadence, hour, minute, timezone, recipient_emails,
           next_run_at, active, created_by, updated_by, authorization_snapshot)
        values (${scheduleId}, ${oid}, ${definitionId}, 'daily', 7, 0, 'UTC',
                ${JSON.stringify(["controller@example.test"])}::jsonb,
                ${new Date().toISOString()}, true, ${editorId}, ${editorId},
                ${JSON.stringify(pin)}::jsonb)
      `);
    });
    gate.user = { orgId: oid, id: editorId };
    gate.permissions = ["reports.schedule", "reports.read"];
    gate.allowedSubsidiaryIds = null;

    for (const [body, label] of [
      [{ hour: 8, reason: "shift delivery hour" }, "hour"],
      [{ active: false, reason: "pause delivery" }, "active"],
    ] as const) {
      const patched = await PATCH(json("PATCH", body), params(scheduleId));
      assert.equal(patched.status, 200, `${label} PATCH: ${await patched.clone().text()}`);
      const stored = await withBypassContext(async () =>
        (
          await db.execute<{ authorization_snapshot: typeof pin }>(sql`
            select authorization_snapshot from report_schedules
             where id = ${scheduleId} and org_id = ${oid}
          `)
        ).rows[0],
      );
      assert.ok(stored, `${label} PATCH left a schedule row`);
      assert.notEqual(
        stored!.authorization_snapshot.allowedSubsidiaryIds,
        null,
        `${label} PATCH must not persist the editor's org-unrestricted allowlist`,
      );
      assert.deepEqual(
        stored!.authorization_snapshot.allowedSubsidiaryIds,
        [fixture.subsidiaryId],
        `${label} PATCH must keep the original legal-entity pin`,
      );
      assert.equal(stored!.authorization_snapshot.userId, pin.userId);
      assert.equal(stored!.authorization_snapshot.version, 1);
    }
  } finally {
    resetGate();
    await withBypassContext(() => dropScratchOrg(oid));
  }
});
