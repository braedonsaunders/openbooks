import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertFixtureDatabase } from "./fixture-database.ts";

export interface FlowActors {
  /** The document creator (submitter). */
  submitterId: string;
  /** Two independent approvers (for quorum any/all). */
  approver1Id: string;
  approver2Id: string;
  /** An org admin (canActOnGate via the admin role). */
  adminId: string;
  /** An active user with no granted permissions (for negative/authz tests). */
  outsiderId: string;
}

/** Create an active scratch user and its explicit role assignment atomically. */
export async function createScratchUser(
  orgId: string,
  name: string,
  roleKey: string,
  userId = randomUUID(),
): Promise<string> {
  await assertFixtureDatabase();
  const nativeRole = BUILT_IN_ROLES[roleKey];
  await db.transaction(async (tx) => {
    const role = await tx.execute<{ id: string }>(
      sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, ${roleKey}, ${nativeRole?.name ?? roleKey.replaceAll("_", " ")}, ${nativeRole !== undefined},
        ${JSON.stringify(nativeRole?.permissions ?? [])}::jsonb)
      on conflict (org_id, key) do update set updated_at = now()
      returning id
    `,
      "objects",
    );
    await tx.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${userId}, ${orgId}, ${`u-${userId.slice(0, 8)}@scratch.test`}, ${name}, 'x', true)
    `);
    await tx.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${orgId}, ${userId}, ${role[0]!.id})
    `);
  });
  return userId;
}

/** Grant only the native duties exercised by a fixture's authorized actor. */
export async function grantScratchPermissions(
  orgId: string,
  userId: string,
  permissions: readonly string[],
): Promise<void> {
  await assertFixtureDatabase();
  for (const permission of new Set(permissions)) {
    const granted = await db.execute<{ permission: string }>(
      sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
      where user_permission_overrides.org_id = excluded.org_id
      returning permission`,
      "objects",
    );
    if (granted.length !== 1) throw new Error(`fixture permission ${permission} was not granted`);
  }
}

/** Create the active employee-role row required by timekeeping fixtures. */
export async function seedActiveEmployment(
  orgId: string,
  partyId: string,
  hiredOn = "2026-01-01",
): Promise<void> {
  await assertFixtureDatabase();
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active)
    values (${orgId}, ${partyId}, ${hiredOn}, true)`);
}

/** Create an HRM employment and return its id for payroll fixture records. */
export async function seedWorkerEmployment(
  orgId: string,
  workerPartyId: string,
  employerSubsidiaryId: string,
): Promise<string> {
  await assertFixtureDatabase();
  const id = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
    values (${id}, ${orgId}, ${workerPartyId}, ${employerSubsidiaryId})`);
  return id;
}

/** Record an explicit work-region allocation for a payroll period. */
export async function seedWorkAllocation(
  orgId: string,
  employmentId: string,
  periodStart: string,
  periodEnd: string,
  region: string,
  subregion: string | null,
  workShare: string,
  source = "hr_records",
  changeReason = "test fixture allocation",
): Promise<void> {
  await assertFixtureDatabase();
  await db.execute(sql`
    insert into payroll_work_location_allocations
      (org_id, employment_id, period_start, period_end, region, subregion,
       service_days, work_share, source, change_reason)
    values (${orgId}, ${employmentId}, ${periodStart}::date, ${periodEnd}::date,
            ${region}, ${subregion}, null, ${workShare}, ${source}, ${changeReason})`);
}

/** Seed the users an approval-flow test needs. Passwords are placeholders. */
export async function seedFlowActors(orgId: string): Promise<FlowActors> {
  const mk = async (name: string, role: string): Promise<string> => {
    return createScratchUser(orgId, name, role);
  };
  const actors = {
    submitterId: await mk("Submitter", "accountant"),
    approver1Id: await mk("Approver One", "approver"),
    approver2Id: await mk("Approver Two", "approver"),
    adminId: await mk("Admin", "admin"),
    outsiderId: await mk("Outsider", "permissionless"),
  };
  return actors;
}

export type SeedAssignee =
  | { type: "user"; userId: string }
  | { type: "role"; role: string }
  | { type: "submitter" }
  | { type: "supervisor" };

/** Seed an approval flow with a trigger and one approval gate. */
export async function seedApprovalFlow(
  orgId: string,
  opts: {
    subjectKind: string;
    assignees: SeedAssignee[];
    mode: "any" | "all";
    preventSelfApproval?: boolean;
    gateTitle?: string;
    trigger?: string;
    /** Optional threshold condition between the trigger and the gate. */
    condition?: { field: string; op: "gt"; value: number };
  },
): Promise<{ flowId: string; gateNodeId: string }> {
  await assertFixtureDatabase();
  const flowId = randomUUID();
  const gateNodeId = "gate";
  const conditionNode = opts.condition
    ? {
        id: "condition",
        position: { x: 110, y: 0 },
        data: {
          kind: "condition",
          rule: {
            op: opts.condition.op,
            field: opts.condition.field,
            value: opts.condition.value,
            valueType: "number" as const,
          },
        },
      }
    : null;
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: opts.trigger ?? "on_submit" } },
      },
      ...(conditionNode ? [conditionNode] : []),
      {
        id: gateNodeId,
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: opts.gateTitle ?? "Approval",
            assignees: opts.assignees,
            mode: opts.mode,
            ...(opts.preventSelfApproval !== undefined
              ? { preventSelfApproval: opts.preventSelfApproval }
              : {}),
          },
        },
      },
    ],
    edges: opts.condition
      ? [
          { id: "e1", source: "trigger", target: "condition", sourceHandle: "next" },
          { id: "e2", source: "condition", target: gateNodeId, sourceHandle: "then" },
        ]
      : [{ id: "e1", source: "trigger", target: gateNodeId, sourceHandle: "next" }],
  };
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, ${"Test approval"}, ${opts.subjectKind}, true, ${JSON.stringify(graph)}::jsonb)`);
  return { flowId, gateNodeId };
}

/** Insert a minimal draft document for approval-lifecycle tests. */
export async function seedDraftDocument(
  orgId: string,
  opts: { kind: string; createdBy: string; total?: string; number?: string },
): Promise<string> {
  await assertFixtureDatabase();
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency,
       subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, ${opts.kind}, 'draft', ${opts.number ?? `T-${id.slice(0, 8)}`},
            '2026-07-15', 'CAD', ${opts.total ?? "100.00"}, '0.00', ${opts.total ?? "100.00"}, ${opts.createdBy})`);
  return id;
}
