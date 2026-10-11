import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { documentRevisionSql } from '@openbooks/engine/src/records/revision.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  QUICK_APPROVAL_FLOW_DESCRIPTION,
  buildQuickApprovalGraph,
  flowSubjectProfileForOrg,
  lintFlowGraphForSubject,
  listFlowSubjectProfiles,
  quickApprovalAmountField,
} from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/**
 * One-step approval setup — the four-click path to a governed record kind.
 *
 * POST builds a complete, wired, ENABLED flow (on_submit trigger → optional
 * threshold condition → approval gate) through the same lint the designer
 * save path enforces, with the same audited insert the New Flow path
 * writes. GET reports the setup state for one subject kind (the quick flow
 * if present, plus the approver choices) so the dialog can offer removal —
 * which disables the flow through PATCH /api/admin/flows/[id], never a
 * delete, preserving execution history.
 */

const FLOW_SUBJECT_KINDS = listFlowSubjectProfiles().map((profile) => profile.subjectKind) as [string, ...string[]];

const approverSchema = z.union([
  z.object({ type: z.literal('user'), userId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('role'), role: z.string().min(1).max(64) }),
]);

const requestBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  subjectKind: z.enum(FLOW_SUBJECT_KINDS),
  threshold: z.number().finite().min(0).max(1_000_000_000_000).optional(),
  approver: approverSchema,
  preventSelfApproval: z.boolean().optional(),
});

async function legacyGET(req: Request) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const subjectKind = new URL(req.url).searchParams.get('subjectKind') ?? ''
  if (!listFlowSubjectProfiles().some((profile) => profile.subjectKind === subjectKind)) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 })
  }
  const profile = await flowSubjectProfileForOrg(gate.user.orgId, subjectKind)
  if (!profile) {
    return NextResponse.json({ error: `unknown subject kind "${subjectKind}"` }, { status: 400 })
  }
  const [flowRes, usersRes, rolesRes] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select id, name, enabled, ${documentRevisionSql(sql`updated_at`)} as updated_at
        from flows
       where org_id = ${gate.user.orgId} and subject_kind = ${subjectKind}
         and description = ${QUICK_APPROVAL_FLOW_DESCRIPTION}
       order by updated_at desc limit 1`),
    db.execute<Record<string, unknown>>(sql`
      select id, name, email from users
       where org_id = ${gate.user.orgId} and is_active
       order by name`),
    db.execute<Record<string, unknown>>(sql`
      select key, name from app_roles
       where org_id = ${gate.user.orgId}
       order by name`),
  ])
  const flow = flowRes.rows[0]
  return NextResponse.json({
    flow: flow
      ? {
          id: String(flow.id),
          name: String(flow.name),
          enabled: Boolean(flow.enabled),
          updatedAt: String(flow.updated_at),
        }
      : null,
    users: usersRes.rows.map((user) => ({
      id: String(user.id),
      name: String(user.name),
      email: String(user.email),
    })),
    roles: rolesRes.rows.map((role) => ({
      key: String(role.key),
      name: String(role.name),
    })),
    amountField: quickApprovalAmountField(profile),
    subjectLabel: profile.label,
  })
}

export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  handler: async ({ request }) => legacyGET(request as Request),
});

export const POST = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz
    const user = gate.user

    const profile = await flowSubjectProfileForOrg(user.orgId, body.subjectKind)
    if (!profile) {
      return NextResponse.json({ error: `unknown subject kind "${body.subjectKind}"` }, { status: 400 })
    }
    const usersRes = body.approver.type === 'user'
      ? await db.execute<{ id: string }>(sql`
          select id from users where org_id = ${user.orgId} and is_active`)
      : null;
    const built = buildQuickApprovalGraph(
      profile,
      {
        approver: body.approver,
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.preventSelfApproval !== undefined ? { preventSelfApproval: body.preventSelfApproval } : {}),
      },
      usersRes ? new Set(usersRes.rows.map((row) => String(row.id))) : undefined,
    )
    if (!built.ok) {
      return NextResponse.json({ error: built.message, code: built.code }, { status: 400 })
    }
    // The setup promises an enabled flow: prove the generated graph passes
    // the same lint the designer save path enforces before writing anything.
    const lint = lintFlowGraphForSubject(body.subjectKind, built.graph, profile)
    if (!lint.ok) {
      return NextResponse.json({ errors: lint.errors }, { status: 400 })
    }
    const name = body.name?.trim() || `Approval: ${profile.label}`
    const id = await db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        insert into flows (org_id, name, description, subject_kind, enabled, graph, created_by, updated_by)
        values (${user.orgId}, ${name}, ${QUICK_APPROVAL_FLOW_DESCRIPTION}, ${body.subjectKind}, true,
                ${JSON.stringify(built.graph)}::jsonb, ${user.id}, ${user.id})
        returning *`);
      const created = r.rows[0]!
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${user.orgId}, 'flows', ${created.id}, 'insert',
           ${JSON.stringify({ after: created })}::jsonb,
           ${user.id}, ${request.headers.get('X-Request-Id')})`)
      return created.id
    })
    return NextResponse.json({ id })
  },
});
