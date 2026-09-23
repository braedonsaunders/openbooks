import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import test from "node:test";

/**
 * DELETE /api/reports/definitions/[id] must archive, never destroy history.
 * Runs reference their definition (and artifacts cascade off runs), so the
 * old hard delete wiped every materialization, its CSV evidence and its
 * immutable PDF artifacts. After an archive the runs, CSV and artifact stay
 * downloadable by run id under the run's own authorization snapshot, the
 * definition hides from lists and execution, and its schedules stop.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const gateState = { orgId: "org-1", userId: "user-1" };
(globalThis as Record<string, unknown>).__definitionArchiveGate = gateState;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return nextResolve(root + "web/lib/api/json.ts", context);
    }
    if (specifier === "@/lib/custom-record-report-catalog") {
      return nextResolve(root + "web/lib/custom-record-report-catalog.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              const gate = globalThis.__definitionArchiveGate;
              return {
                user: { orgId: gate.orgId, id: gate.userId },
                permissions: new Set(['reports.read', 'reports.create']),
                allowedSubsidiaryIds: null,
              };
            }
            export function can(authz, perm) { return authz.permissions.has(perm) }
          `),
      };
    }
    return nextResolve(specifier, context);
  },
});

const { db, withBypass, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { DELETE } = await import("./[id]/route.ts");
const { GET: listDefinitions } = await import("./route.ts");
const { GET: downloadArtifact } = await import("../runs/[id]/artifact/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test(
  "definition delete archives and preserves runs, csv and artifacts",
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    gateState.orgId = org.orgId;
    gateState.userId = actorId;
    const definitionId = randomUUID();
    const runId = randomUUID();
    const scheduleId = randomUUID();
    const artifactBytes = Buffer.from("%PDF-1.4 archived-proof");
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into report_definitions
            (id, org_id, kind, report_type, slug, name, description, query, statement, system, created_by, updated_by)
          values
            (${definitionId}, ${org.orgId}, 'custom', 'statement', 'archive-me', 'Archive me',
             null, null, ${JSON.stringify({ kind: "pnl" })}::jsonb, false, ${actorId}, ${actorId})
        `),
      );
      await withBypass(() =>
        db.execute(sql`
          insert into report_schedules
            (id, org_id, definition_id, cadence, next_run_at, active, recipient_emails)
          values
            (${scheduleId}, ${org.orgId}, ${definitionId}, 'daily', now() + interval '1 day', true, '[]'::jsonb)
        `),
      );
      const snapshot = {
        version: 1,
        userId: actorId,
        definition: { report_type: "statement", statement: { kind: "pnl" }, query: null },
        allowedSubsidiaryIds: null,
      };
      await withBypass(() =>
        db.execute(sql`
          insert into report_runs
            (id, org_id, schedule_id, definition_id, trigger, status, result_csv, authorization_snapshot, created_by)
          values
            (${runId}, ${org.orgId}, ${scheduleId}, ${definitionId}, 'scheduled', 'finished',
             'a,b\n1,2', ${JSON.stringify(snapshot)}::jsonb, ${actorId})
        `),
      );
      await withBypass(() =>
        db.execute(sql`
          insert into report_run_artifacts
            (org_id, run_id, filename, content_type, size_bytes, content_hash, bytes, created_by)
          values
            (${org.orgId}, ${runId}, 'report.pdf', 'application/pdf', ${artifactBytes.length},
             ${"ab".repeat(32)}, ${artifactBytes}, ${actorId})
        `),
      );

      await withOrgContext(org.orgId, async () => {
        const res = await DELETE(
          new Request("http://audit.local/api/reports/definitions/x", { method: "DELETE" }),
          params(definitionId),
        );
        assert.equal(res.status, 200);

        // The definition row survives as archived — runs keep their parent.
        const def = (
          await db.execute<{ archived_at: string | null; archived_by: string | null }>(sql`
            select archived_at::text as archived_at, archived_by::text as archived_by
              from report_definitions where id = ${definitionId} and org_id = ${org.orgId}
          `)
        ).rows[0]!;
        assert.ok(def.archived_at, "definition is stamped archived, not deleted");
        assert.equal(def.archived_by, actorId);

        const runs = (
          await db.execute<{ n: string }>(sql`
            select count(*)::text as n from report_runs where id = ${runId} and org_id = ${org.orgId}
          `)
        ).rows[0]!.n;
        assert.equal(runs, "1", "the historical run survives the delete");
        const artifacts = (
          await db.execute<{ n: string }>(sql`
            select count(*)::text as n from report_run_artifacts
             where run_id = ${runId} and org_id = ${org.orgId}
          `)
        ).rows[0]!.n;
        assert.equal(artifacts, "1", "the immutable artifact survives the delete");

        // The artifact stays downloadable under the run's original authz.
        const download = await downloadArtifact(
          new Request(`http://audit.local/api/reports/runs/${runId}/artifact`),
          params(runId),
        );
        assert.equal(download.status, 200);
        assert.equal(Buffer.from(await download.arrayBuffer()).toString(), artifactBytes.toString());

        // The archived definition hides from lists and execution.
        const listed = (await listDefinitions()) as Response;
        const catalog = (await listed.json()) as { definitions: { id: string }[] };
        assert.ok(!catalog.definitions.some((d) => d.id === definitionId));

        // Its schedules stop.
        const schedule = (
          await db.execute<{ active: boolean }>(sql`
            select active from report_schedules where id = ${scheduleId} and org_id = ${org.orgId}
          `)
        ).rows[0]!;
        assert.equal(schedule.active, false);

        // The delete is audited with before/after.
        const audits = (
          await db.execute<{ action: string; changes: unknown }>(sql`
            select action, changes from audit_log
             where org_id = ${org.orgId} and table_name = 'report_definitions' and row_id = ${definitionId}
          `)
        ).rows;
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, "delete");
        const changes = audits[0]!.changes as { before: object; after: { archived_at: string } };
        assert.ok(changes.before && changes.after.archived_at);

        // A direct hard delete with surviving runs now fails instead of cascading.
        // The FK violation surfaces on the error cause, not the query text.
        const hardDelete = await withBypass(() =>
          db
            .execute(sql`
              delete from report_definitions where id = ${definitionId} and org_id = ${org.orgId}
            `)
            .then(
              () => "deleted",
              (error: unknown) =>
                `${error instanceof Error ? error.message : String(error)} ${
                  (error as { cause?: { message?: string } })?.cause?.message ?? ""
                }`,
            ),
        );
        assert.match(String(hardDelete), /restrict|violates|still referenced/i);
      });
    } finally {
      gateState.orgId = "org-1";
      gateState.userId = "user-1";
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
