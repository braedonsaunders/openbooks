import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import test from "node:test";

/**
 * PATCH /api/reports/definitions/[id] must evidence every edit: the rename
 * commits together with its audit_log before/after row in one transaction,
 * so an edit can never land without its evidence (POST and DELETE already
 * audit; PATCH did not).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const gateState = { orgId: "org-1", userId: "user-1" };
(globalThis as Record<string, unknown>).__definitionPatchAuditGate = gateState;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier === "@/lib/custom-record-report-catalog") {
      return next(root + "web/lib/custom-record-report-catalog.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              const gate = globalThis.__definitionPatchAuditGate;
              return {
                user: { orgId: gate.orgId, id: gate.userId },
                permissions: new Set(['reports.read', 'reports.create']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});

const { db, withBypass, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { PATCH } = await import("./[id]/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test(
  "definition autosave audits before and after in the same transaction",
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    gateState.orgId = org.orgId;
    gateState.userId = actorId;
    const definitionId = randomUUID();
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into report_definitions
            (id, org_id, kind, report_type, slug, name, description, query, statement, system, created_by, updated_by)
          values
            (${definitionId}, ${org.orgId}, 'custom', 'statement', 'aged-audit', 'Aged audit',
             null, null, ${JSON.stringify({ kind: "pnl" })}::jsonb, false, ${actorId}, ${actorId})
        `),
      );
      const revision = (
        await withBypass(() =>
          db.execute<{ updated_at: string }>(sql`
            select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
              from report_definitions where id = ${definitionId} and org_id = ${org.orgId}
          `),
        )
      ).rows[0]!.updated_at;

      await withOrgContext(org.orgId, async () => {
        const res = await PATCH(
          new Request("http://audit.local/api/reports/definitions/x", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Aged audit v2", expectedUpdatedAt: revision }),
          }),
          params(definitionId),
        );
        assert.equal(res.status, 200);
        const payload = (await res.json()) as { definition: { name: string } };
        assert.equal(payload.definition.name, "Aged audit v2");

        const audits = (
          await db.execute<{ action: string; actor_id: string; changes: unknown }>(sql`
            select action, actor_id, changes from audit_log
             where org_id = ${org.orgId} and table_name = 'report_definitions' and row_id = ${definitionId}
          `)
        ).rows;
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, "update");
        assert.equal(audits[0]!.actor_id, actorId);
        const changes = audits[0]!.changes as {
          before: { name: string };
          after: { name: string };
        };
        assert.equal(changes.before.name, "Aged audit");
        assert.equal(changes.after.name, "Aged audit v2");
      });
    } finally {
      gateState.orgId = "org-1";
      gateState.userId = "user-1";
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
