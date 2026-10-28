import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { jsonObject, validateJsonBody } from "@/lib/api/json";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { documentRevisionSql, isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "@/lib/authz";
import { automationGraphSchema } from "@openbooks/forms-core";
import {
  flowSubjectProfileForOrg,
  lintFlowGraphForSubject,
  validateFlowSubjectScopeRefs,
} from "@openbooks/engine/flows/module";
import { filterFlowRunSubjectsToScope } from "../../../flows/_lib";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const requestBodySchema = z.object({
  description: z.string().optional().describe("Flow description."),
  enabled: z.boolean().optional().describe("Whether the flow is published and active."),
  expectedUpdatedAt: z.string().optional().describe("Exact flow revision from get_admin_flow."),
  graph: automationGraphSchema.optional().describe("Flow graph definition to save."),
  name: z.string().optional().describe("Flow name."),
});

export const runtime = "nodejs";

/**
 * One flow — read (with recent runs), rename/describe/enable/save-graph,
 * delete unused definitions while preserving execution history.
 *
 * Graph saves are validated in two tiers:
 *   • STRUCTURAL (zod graph schema — malformed nodes/edges/caps) → 400
 *     field issues; nothing is written.
 *   • VOCABULARY / wiring lints (lintFlowGraphForSubject: unreachable nodes,
 *     triggers without an outgoing step, unknown fields/statuses,
 *     worker-trigger compatibility, …) → the graph still saves (authors keep
 *     work-in-progress) and the lints come back as {warnings} for the
 *     builder to surface non-blocking.
 */

type Params = { params: Promise<{ id: string }> };

async function loadFlow(orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const r = await db.execute<Record<string, unknown>>(
    sql`
    select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at from flows where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return r[0] ?? null;
}

export async function readAdminFlowAction(_req: Request, { params }: Params, gate: Authz) {
  const { id } = await params;
  const flow = await loadFlow(gate.user.orgId, id);
  if (!flow) return notFound("record");
  const runs = await db.execute<Record<string, unknown>>(
    sql`
    select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
      from flow_runs where flow_id = ${id} and org_id = ${gate.user.orgId}
     order by started_at desc limit 30
  `,
    "objects",
  );
  // A subsidiary-restricted flows.manage caller sees only runs whose
  // subject sits inside their scope — the same subject rule the retry
  // route enforces per run. Out-of-scope runs (and their subject UUIDs,
  // errors and timestamps) are dropped, never redacted in place.
  const visibleRuns = await filterFlowRunSubjectsToScope(
    gate.user.orgId,
    gate.allowedSubsidiaryIds,
    runs.map((row) => ({
      kind: String(row.subject_kind),
      id: String(row.subject_id),
      row,
    })),
    gate,
  );
  return NextResponse.json({
    flow,
    runs: visibleRuns.map((subject) => subject.row),
  });
}

function revisionConflict() {
  return NextResponse.json(
    { error: "The flow has changed. Reload it before saving or deleting." },
    { status: 409 },
  );
}

export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    readAdminFlowAction(
      request as never,
      { params: Promise.resolve(params as never) } as never,
      authz,
    ),
});

export async function updateAdminFlowAction({
  request,
  params,
  body: rawBody,
  authz: routeAuthz,
}: {
  request: Request;
  params: { id: string };
  body: Record<string, unknown>;
  authz: Authz;
}) {
  const gate = routeAuthz;

  const user = gate.user;
  const { id } = params;
  if (!isUuid(id)) return notFound("record");
  const expectedUpdatedAt = rawBody.expectedUpdatedAt;
  if (!isDocumentRevisionToken(expectedUpdatedAt)) return revisionConflict();
  const parsedBody = validateJsonBody(rawBody, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)
  ) {
    return NextResponse.json({ errors: ["name required (max 200 chars)"] }, { status: 400 });
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    return NextResponse.json({ error: "description must be a string or null" }, { status: 400 });
  }
  return db.transaction(async (tx) => {
    const flow = (
      await tx.execute<Record<string, unknown>>(
        sql`
        select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
          from flows where id = ${id} and org_id = ${user.orgId} for update
      `,
        "objects",
      )
    )[0];
    if (!flow) return notFound("record");
    if (flow.updated_at !== expectedUpdatedAt) return revisionConflict();
    const sets = [
      sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')`,
      sql`updated_by = ${user.id}`,
    ];
    if (typeof body.name === "string") sets.push(sql`name = ${body.name.trim()}`);
    if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
    if (body.enabled !== undefined) sets.push(sql`enabled = ${body.enabled}`);

    let warnings: string[] = [];
    let scopeRefusal: string | null = null;
    if (body.graph !== undefined) {
      // Structural gate: a graph the executor cannot even parse is rejected.
      const parsed = automationGraphSchema.safeParse(body.graph);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "graph"}: ${i.message}`,
        );
        return NextResponse.json({ errors }, { status: 400 });
      }
      // Author-time lints are non-blocking: report, but store positions as-is.
      const profile = await flowSubjectProfileForOrg(user.orgId, String(flow.subject_kind));
      const lint = lintFlowGraphForSubject(
        String(flow.subject_kind),
        parsed.data,
        profile ?? undefined,
      );
      warnings = lint.ok ? [] : lint.errors;
      // Legal-entity limits name native subsidiary references: they must
      // exist in this organization and sit inside the writer's ceiling.
      // Drafts keep the refusal as a warning; an enabled flow may not
      // persist an unchecked limit (see the blocking lint below).
      scopeRefusal = await validateFlowSubjectScopeRefs(
        user.orgId,
        parsed.data,
        gate.allowedSubsidiaryIds,
      );
      if (scopeRefusal) warnings = [...warnings, scopeRefusal];
      sets.push(sql`graph = ${JSON.stringify(parsed.data)}::jsonb`);
    }

    // Drafts may retain authoring warnings, but an enabled flow must be fully
    // executable against the tenant's current roles and custom fields. The
    // blocking lint applies whenever the save leaves the flow ENABLED — an
    // explicit enable, or any save to an already-enabled flow (otherwise a
    // graph edit could smuggle change_status→approved nodes past the
    // engine-managed-release invariant as mere warnings). A flow being disabled,
    // or a draft, stays warning-only so authoring keeps its work-in-progress.
    const willBeEnabled =
      body.enabled === undefined ? Boolean(flow.enabled) : Boolean(body.enabled);
    if (willBeEnabled && scopeRefusal) {
      return NextResponse.json({ errors: [scopeRefusal] }, { status: 400 });
    }
    if (willBeEnabled) {
      const candidateGraph = body.graph ?? flow.graph;
      // Enabling also revalidates a stored graph's legal-entity limit:
      // an entity deleted since the draft was saved must not silently
      // become the enabled policy's scope.
      const candidateRefusal =
        scopeRefusal ??
        (await validateFlowSubjectScopeRefs(
          user.orgId,
          candidateGraph as { subjectScope?: { subsidiaryIds: string[] } },
          gate.allowedSubsidiaryIds,
        ));
      if (candidateRefusal)
        return NextResponse.json({ errors: [candidateRefusal] }, { status: 400 });
      const profile = await flowSubjectProfileForOrg(user.orgId, String(flow.subject_kind));
      const lint = lintFlowGraphForSubject(
        String(flow.subject_kind),
        candidateGraph,
        profile ?? undefined,
      );
      if (!lint.ok) return NextResponse.json({ errors: lint.errors }, { status: 400 });
    }

    const updated = await tx.execute<Record<string, unknown>>(
      sql`
        update flows set ${sql.join(sets, sql`, `)}
         where id = ${id} and org_id = ${user.orgId}
         returning flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
      `,
      "objects",
    );
    if (!updated[0]) throw new Error("flow_changed");
    await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${user.orgId}, 'flows', ${id}, 'update',
           ${JSON.stringify({ before: flow, after: updated[0] })}::jsonb,
           ${user.id}, ${request.headers.get("X-Request-Id")})
      `);
    // The persisted flag rides back so the designer and list switches render
    // the stored state (the single source), never their optimistic copy.
    return NextResponse.json({
      ok: true,
      warnings,
      updatedAt: updated[0].updated_at,
      enabled: Boolean(updated[0].enabled),
    });
  });
}

export const PATCH = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  body: jsonObject,
  handler: updateAdminFlowAction,
});

export async function deleteAdminFlowAction({
  request,
  params,
  body: rawBody,
  authz: routeAuthz,
}: {
  request: Request;
  params: { id: string };
  body: Record<string, unknown>;
  authz: Authz;
}) {
  const gate = routeAuthz;

  const orgId = gate.user.orgId;
  const { id } = params;
  if (!isUuid(id)) return notFound("record");
  const expectedUpdatedAt = rawBody.expectedUpdatedAt;
  if (!isDocumentRevisionToken(expectedUpdatedAt)) return revisionConflict();
  const parsedBody = validateJsonBody(rawBody, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;

  return db.transaction(async (tx) => {
    // Lock the parent before checking children. Run/gate inserts take a foreign-key
    // key-share lock, so approvals cannot arrive between the check and deletion.
    const flow = (
      await tx.execute<Record<string, unknown>>(
        sql`
        select flows.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
          from flows where id = ${id} and org_id = ${orgId} for update
      `,
        "objects",
      )
    )[0];
    if (!flow) return notFound("record");
    if (flow.updated_at !== expectedUpdatedAt) return revisionConflict();
    const history = (
      await tx.execute<{ used: boolean }>(
        sql`
        select exists(select 1 from flow_runs where flow_id = ${id} and org_id = ${orgId})
            or exists(select 1 from flow_gates where flow_id = ${id} and org_id = ${orgId}) as used
      `,
        "objects",
      )
    )[0];
    if (history?.used)
      return NextResponse.json(
        {
          error:
            "This flow has execution or approval history. Disable it to preserve that history.",
        },
        { status: 409 },
      );
    await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${orgId}, 'flows', ${id}, 'delete',
           ${JSON.stringify({ before: flow })}::jsonb,
           ${gate.user.id}, ${request.headers.get("X-Request-Id")})
      `);
    const deleted = await tx.execute<{ id: string }>(
      sql`delete from flows where id = ${id} and org_id = ${orgId} returning id`,
      "objects",
    );
    if (deleted.length !== 1) throw new Error("flow_changed");
    return NextResponse.json({ ok: true });
  });
}

export const DELETE = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  body: jsonObject,
  handler: deleteAdminFlowAction,
});
