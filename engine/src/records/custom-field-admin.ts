import { sql } from "drizzle-orm";
import { documentRevisionSql } from "./revision.ts";
import { lockCustomFieldKeys } from "./custom-field-write-lock.ts";
import { db } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";

export interface ExistingCustomFieldDefinition {
  id: string;
  updated_at: string;
  target_table: string;
  target_kind: string | null;
  key: string;
  label: string;
  field_type: string;
  config: unknown;
  is_required: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface CreateCustomFieldDefinitionInput {
  targetTable: string;
  targetKind?: string | null;
  key: string;
  label: string;
  fieldType: string;
  config: Record<string, unknown>;
  isRequired?: boolean;
  sortOrder?: number;
}

export async function createCustomFieldDefinition(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  input: CreateCustomFieldDefinitionInput;
}): Promise<{ kind: "duplicate" } | { kind: "created"; id: string; updatedAt: string }> {
  const { orgId, actorId, requestId, input } = args;
  return db.transaction(async (tx) => {
    await lockCustomFieldKeys(tx, orgId, [{ targetTable: input.targetTable, key: input.key }]);
    const dup = await tx.execute(
      sql`
      select 1 from custom_field_defs
       where org_id = ${orgId} and target_table = ${input.targetTable}
         and coalesce(target_kind, '') = coalesce(${input.targetKind ?? null}, '')
         and key = ${input.key}
    `,
      "objects",
    );
    if (dup.length > 0) return { kind: "duplicate" };

    const created = (
      await tx.execute<{ id: string; updated_at: string }>(
        sql`
      insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type, config, is_required, sort_order, created_by, updated_by)
      values (${orgId}, ${input.targetTable}, ${input.targetKind ?? null}, ${input.key}, ${input.label},
              ${input.fieldType}, ${JSON.stringify(input.config)}::jsonb, ${input.isRequired === true}, ${Number(input.sortOrder ?? 0)}, ${actorId}, ${actorId})
      -- A concurrently claimed field key returns the explicit duplicate-key refusal below.
      on conflict do nothing
      returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                ${documentRevisionSql(sql`updated_at`)} as updated_at
    `,
        "objects",
      )
    )[0];
    if (!created) return { kind: "duplicate" };
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'custom_field_defs', ${created.id}, 'insert',
              ${JSON.stringify({ after: created })}::jsonb, ${actorId}, ${requestId})
    `);
    return { kind: "created", id: created.id, updatedAt: created.updated_at };
  });
}

export type UpdateCustomFieldDefinitionResult =
  | { kind: "missing" }
  | { kind: "target_disabled" }
  | { kind: "revision_conflict" }
  | { kind: "invalid"; error: string }
  | { kind: "updated"; updatedAt: string };

export async function updateCustomFieldDefinition(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  id: string;
  expectedUpdatedAt: string;
  body: Record<string, unknown>;
  isTargetEnabled: (
    orgId: string,
    table: string,
    kind: string | null,
    executor?: SqlExecutor,
  ) => Promise<boolean>;
  validate: (
    body: Record<string, unknown>,
    existing: ExistingCustomFieldDefinition,
  ) => string | null;
  normalizeConfig: (input: unknown) => Record<string, unknown>;
}): Promise<UpdateCustomFieldDefinitionResult> {
  const { orgId, actorId, requestId, id, expectedUpdatedAt, body } = args;
  return db.transaction(async (tx) => {
    const existing = (
      await tx.execute<ExistingCustomFieldDefinition>(
        sql`
      select custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
             ${documentRevisionSql(sql`updated_at`)} as updated_at
        from custom_field_defs
       where id = ${id} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!existing) return { kind: "missing" };
    if (!(await args.isTargetEnabled(orgId, existing.target_table, existing.target_kind))) {
      return { kind: "target_disabled" };
    }
    if (existing.updated_at !== expectedUpdatedAt) return { kind: "revision_conflict" };

    const error = args.validate(body, existing);
    if (error) return { kind: "invalid", error };

    const label = body.label === undefined ? existing.label : body.label;
    const fieldType = body.fieldType === undefined ? existing.field_type : body.fieldType;
    const config = args.normalizeConfig(body.config === undefined ? existing.config : body.config);
    const isRequired =
      body.isRequired === undefined ? existing.is_required : body.isRequired === true;
    const sortOrder =
      body.sortOrder === undefined ? existing.sort_order : Number(body.sortOrder ?? 0);
    const isActive = body.isActive === undefined ? existing.is_active : body.isActive !== false;
    const updated = (
      await tx.execute<{ updated_at: string }>(
        sql`
      update custom_field_defs set
        label = ${label}, field_type = ${fieldType}, config = ${JSON.stringify(config)}::jsonb,
        is_required = ${isRequired}, sort_order = ${sortOrder}, is_active = ${isActive},
        updated_by = ${actorId},
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where id = ${id} and org_id = ${orgId}
      returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                ${documentRevisionSql(sql`updated_at`)} as updated_at
    `,
        "objects",
      )
    )[0]!;
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'custom_field_defs', ${id}, 'update',
              ${JSON.stringify({ before: existing, after: updated })}::jsonb, ${actorId}, ${requestId})
    `);
    return { kind: "updated", updatedAt: updated.updated_at };
  });
}
