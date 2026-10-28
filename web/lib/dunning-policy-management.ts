import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { claimSetupCreate, SetupCreateConflict } from "./api/idempotency";
import { dunningStageIdentities } from "./dunning-stage-identity";

export interface DunningPolicyStage {
  id?: string;
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate?: boolean;
}

export class DunningPolicyEditConflict extends Error {
  readonly status = 409;
  constructor(
    message = "This policy changed or was removed while you were editing. Close the editor, refresh Policies, and reopen the record before saving.",
  ) {
    super(message);
  }
}

export class DunningPolicyStagesRefusal extends Error {
  readonly status = 422;
  constructor() {
    super(
      "cannot activate a policy with no stages — add at least one stage or deactivate it first",
    );
  }
}

export function retryOffsetsSql(offsets: number[]): SQL {
  return offsets.length > 0
    ? sql`ARRAY[${sql.join(
        offsets.map((offset) => sql`${offset}`),
        sql`, `,
      )}]`
    : sql`'{}'::integer[]`;
}

export async function listDunningPolicies(orgId: string): Promise<Record<string, unknown>[]> {
  const policies = await db.execute<Record<string, unknown>>(
    sql`
      select id, name, applies_to_kind as "appliesToKind", grace_period_days as "gracePeriodDays",
             min_balance as "minBalance", reply_to as "replyTo", is_active as "isActive",
             autopay_retry_offsets_days as "retryOffsetsDays",
             autopay_insufficient_funds_offsets_days as "insufficientFundsOffsetsDays",
             autopay_expiry_notice_days as "expiryNoticeDays", autopay_final_action as "finalAction",
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
        from dunning_policies where org_id = ${orgId} order by name
    `,
    "objects",
  );
  const stages = await db.execute<Record<string, unknown>>(
    sql`
      select id, policy_id as "policyId", sequence, name, offset_days as "offsetDays",
             subject_template as "subjectTemplate", body_template as "bodyTemplate", escalate
        from dunning_stages where org_id = ${orgId} order by policy_id, sequence
    `,
    "objects",
  );
  const byPolicy = new Map<string, Record<string, unknown>[]>();
  for (const stage of stages) {
    const key = stage.policyId as string;
    (byPolicy.get(key) ?? byPolicy.set(key, []).get(key)!).push(stage);
  }
  const retryRows = (offsets: unknown) =>
    (Array.isArray(offsets) ? offsets : []).map((days) => ({ days }));
  return policies.map((policy) => ({
    ...policy,
    retryOffsetsDays: retryRows(policy.retryOffsetsDays),
    insufficientFundsOffsetsDays: retryRows(policy.insufficientFundsOffsetsDays),
    stages: byPolicy.get(policy.id as string) ?? [],
  }));
}

export interface CreateDunningPolicyInput {
  name: string;
  appliesToKind: string;
  gracePeriodDays: number;
  minBalance: string;
  replyTo: string | null;
  isActive: boolean;
  stages: DunningPolicyStage[];
  retryOffsetsDays?: number[];
  insufficientFundsOffsetsDays?: number[];
  expiryNoticeDays?: number;
  finalAction?: "none" | "suspend" | "cancel";
}

export async function createDunningPolicyRecord(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  input: CreateDunningPolicyInput;
}): Promise<string> {
  const { input } = args;
  return db.transaction(async (tx) => {
    const match = {
      name: input.name,
      appliesToKind: input.appliesToKind,
      gracePeriodDays: input.gracePeriodDays,
      minBalance: input.minBalance,
      replyTo: input.replyTo,
      isActive: input.isActive,
      stages: input.stages,
    };
    if (args.requestId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"dunning-policy-create:" + args.requestId}, 0))`,
      );
      const claim = await claimSetupCreate(tx, {
        orgId: args.orgId,
        table: "dunning_policies",
        key: args.requestId,
        match,
      });
      if (claim.kind === "replay") return claim.id;
    }
    const created = await tx.execute<Record<string, unknown>>(
      sql`
        insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance,
                                      reply_to, is_active, autopay_retry_offsets_days,
                                      autopay_insufficient_funds_offsets_days, autopay_expiry_notice_days,
                                      autopay_final_action,
                                      created_by, updated_by)
        values (coalesce(${args.requestId}::uuid, gen_random_uuid()), ${args.orgId}, ${input.name}, ${input.appliesToKind},
                ${input.gracePeriodDays}, ${input.minBalance}, ${input.replyTo}, ${input.isActive},
                ${input.retryOffsetsDays ? retryOffsetsSql(input.retryOffsetsDays) : sql`'{}'::integer[]`},
                ${input.insufficientFundsOffsetsDays ? retryOffsetsSql(input.insufficientFundsOffsetsDays) : sql`'{3,7,14}'::integer[]`},
                ${input.expiryNoticeDays ?? 30}, ${input.finalAction ?? "none"},
                ${args.actorId}, ${args.actorId})
        -- A duplicate UUID returns no row and is reported as a create conflict below.
        on conflict (id) do nothing returning *
      `,
      "objects",
    );
    if (!created[0]) throw new SetupCreateConflict("foreign-key");
    const policyId = created[0]!.id as string;
    const insertedStages: Record<string, unknown>[] = [];
    for (const stage of input.stages) {
      const stageRow = await tx.execute<Record<string, unknown>>(
        sql`
          insert into dunning_stages (org_id, policy_id, sequence, name, offset_days, subject_template,
                                      body_template, escalate, created_by, updated_by)
          values (${args.orgId}, ${policyId}, ${stage.sequence}, ${stage.name}, ${stage.offsetDays},
                  ${stage.subjectTemplate}, ${stage.bodyTemplate}, ${stage.escalate ?? false},
                  ${args.actorId}, ${args.actorId})
          returning *
        `,
        "objects",
      );
      if (!stageRow[0])
        throw new Error("The reminder stage was not created; policy creation was rolled back.");
      insertedStages.push(stageRow[0]);
    }
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${args.orgId}, 'dunning_policies', ${policyId}, 'insert',
         ${JSON.stringify({ after: { ...created[0], stages: insertedStages }, match })}::jsonb,
         ${args.actorId}, ${args.requestId})
    `);
    return policyId;
  });
}

export interface UpdateDunningPolicyInput {
  expectedUpdatedAt?: string;
  appliesToKind?: string;
  gracePeriodDays?: number;
  minBalance?: string;
  name?: string;
  replyTo?: string | null;
  isActive?: boolean;
  stages?: DunningPolicyStage[];
  retryOffsetsDays?: number[];
  insufficientFundsOffsetsDays?: number[];
  expiryNoticeDays?: number;
  finalAction?: "none" | "suspend" | "cancel";
}

export async function updateDunningPolicyRecord(args: {
  orgId: string;
  actorId: string;
  policyId: string;
  input: UpdateDunningPolicyInput;
}): Promise<void> {
  const { input } = args;
  await db.transaction(async (tx) => {
    const beforePolicy = await tx.execute<Record<string, unknown>>(
      sql`
        select *, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as policy_revision
          from dunning_policies where id = ${args.policyId} and org_id = ${args.orgId} for update
      `,
      "objects",
    );
    const before = beforePolicy[0];
    if (!before) throw new DunningPolicyEditConflict();
    if (
      input.expectedUpdatedAt !== undefined &&
      before.policy_revision !== input.expectedUpdatedAt
    ) {
      throw new DunningPolicyEditConflict();
    }
    const beforeStages = await tx.execute<Record<string, unknown>>(
      sql`select * from dunning_stages where policy_id = ${args.policyId} and org_id = ${args.orgId} order by sequence`,
      "objects",
    );
    const stages = input.stages;
    if ((input.isActive ?? before.is_active) === true && (stages ?? beforeStages).length === 0) {
      throw new DunningPolicyStagesRefusal();
    }
    const sets: SQL[] = [];
    if ("name" in input) sets.push(sql`name = ${input.name!}`);
    if ("appliesToKind" in input) sets.push(sql`applies_to_kind = ${input.appliesToKind!}`);
    if (input.gracePeriodDays !== undefined)
      sets.push(sql`grace_period_days = ${input.gracePeriodDays}`);
    if (input.minBalance !== undefined) sets.push(sql`min_balance = ${input.minBalance}`);
    if ("replyTo" in input) sets.push(sql`reply_to = ${input.replyTo ?? null}`);
    if ("isActive" in input) sets.push(sql`is_active = ${input.isActive!}`);
    if (input.retryOffsetsDays !== undefined) {
      sets.push(sql`autopay_retry_offsets_days = ${retryOffsetsSql(input.retryOffsetsDays)}`);
    }
    if (input.insufficientFundsOffsetsDays !== undefined) {
      sets.push(
        sql`autopay_insufficient_funds_offsets_days = ${retryOffsetsSql(input.insufficientFundsOffsetsDays)}`,
      );
    }
    if (input.expiryNoticeDays !== undefined)
      sets.push(sql`autopay_expiry_notice_days = ${input.expiryNoticeDays}`);
    if (input.finalAction !== undefined)
      sets.push(sql`autopay_final_action = ${input.finalAction}`);
    let afterPolicy: Record<string, unknown> | undefined;
    if (sets.length || stages !== undefined) {
      sets.push(sql`updated_at = now()`, sql`updated_by = ${args.actorId}`);
      const updated = await tx.execute<Record<string, unknown>>(
        sql`
          update dunning_policies set ${sql.join(sets, sql`, `)}
           where id = ${args.policyId} and org_id = ${args.orgId}
          returning *
        `,
        "objects",
      );
      afterPolicy = updated[0];
      if (!afterPolicy) throw new DunningPolicyEditConflict();
    }
    let afterStages: Record<string, unknown>[] | undefined;
    if (stages) {
      const identities = dunningStageIdentities(
        beforeStages.map((stage) => ({ id: String(stage.id), sequence: Number(stage.sequence) })),
        stages,
      );
      if (!identities.ok) throw new DunningPolicyEditConflict(identities.error);
      await tx.execute(
        sql`delete from dunning_stages where policy_id = ${args.policyId} and org_id = ${args.orgId}`,
      );
      afterStages = [];
      for (const [index, stage] of stages.entries()) {
        const stageId = identities.ids[index] ?? null;
        const original = beforeStages.find((row) => row.id === stageId);
        const stageRow = await tx.execute<Record<string, unknown>>(
          sql`
            insert into dunning_stages (id, org_id, policy_id, sequence, name, offset_days, subject_template,
                                        body_template, escalate, created_at, created_by, updated_by)
            values (coalesce(${stageId}::uuid, gen_random_uuid()), ${args.orgId}, ${args.policyId}, ${stage.sequence},
                    ${stage.name}, ${stage.offsetDays}, ${stage.subjectTemplate}, ${stage.bodyTemplate},
                    ${stage.escalate ?? false}, coalesce(${original?.created_at ?? null}::timestamptz, now()),
                    ${original?.created_by ?? args.actorId}, ${args.actorId})
            returning *
          `,
          "objects",
        );
        if (!stageRow[0]) throw new DunningPolicyEditConflict();
        afterStages.push(stageRow[0]);
      }
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'dunning_policies', ${args.policyId}, 'update',
              ${JSON.stringify({
                before: { ...beforePolicy[0], stages: beforeStages },
                after: { ...(afterPolicy ?? beforePolicy[0]), stages: afterStages ?? beforeStages },
              })}::jsonb,
              ${args.actorId})
    `);
  });
}

export async function deleteDunningPolicyRecord(args: {
  orgId: string;
  actorId: string;
  policyId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const beforePolicy = await tx.execute<Record<string, unknown>>(
      sql`select * from dunning_policies where id = ${args.policyId} and org_id = ${args.orgId} for update`,
      "objects",
    );
    if (!beforePolicy[0]) return false;
    const beforeStages = await tx.execute<Record<string, unknown>>(
      sql`select * from dunning_stages where policy_id = ${args.policyId} and org_id = ${args.orgId} order by sequence`,
      "objects",
    );
    await tx.execute(
      sql`delete from dunning_stages where policy_id = ${args.policyId} and org_id = ${args.orgId}`,
    );
    const removed = await tx.execute<{ id: string }>(
      sql`delete from dunning_policies where id = ${args.policyId} and org_id = ${args.orgId} returning id`,
      "objects",
    );
    if (!removed[0]) throw new Error("dunning policy disappeared before deletion");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'dunning_policies', ${args.policyId}, 'delete',
              ${JSON.stringify({ before: { ...beforePolicy[0], stages: beforeStages } })}::jsonb,
              ${args.actorId})
    `);
    return true;
  });
}
