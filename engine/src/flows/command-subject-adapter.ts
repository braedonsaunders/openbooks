import { approvalRequestHref } from "./review-links.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { sql, type SQL } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import type { FlowSubjectAdapter, FlowSubjectScope } from "./types.ts";
import { FlowDispatchError } from "./dispatch-result.ts";

interface CommandSubjectDefinition {
  kind: string;
  label: string;
  table: string;
  statusColumn: string;
  statuses: string[];
  scope: FlowSubjectScope;
  permissions: FlowSubjectAdapter["permissions"];
  decisionPermissions?: readonly string[];
  where?: SQL;
  statusSql?: SQL;
  makerColumn?: string;
  makerIds?: SQL;
  fields: ReadonlyArray<{
    key: string;
    column: string;
    label: string;
    type: "text" | "number" | "date" | "bool";
  }>;
  /** Additional child or aggregate evidence, evaluated against the parent alias s. */
  integrity?: SQL;
  /** Native domain fingerprint for records with operational history outside approved terms. */
  fingerprint?: SQL;
}
const identifiers = /^[a-z_][a-z0-9_]*$/;

/** Shared adapter for native approval commands whose owning module retains the lifecycle writer. */
export function defineCommandSubject(config: CommandSubjectDefinition): FlowSubjectAdapter {
  for (const name of [
    config.table,
    config.statusColumn,
    config.makerColumn ?? "created_by",
    ...config.fields.map((f) => f.column),
  ])
    if (!identifiers.test(name))
      throw new Error("Approval subject identifiers must be static SQL identifiers.");
  const profile: FlowSubjectProfile = {
    subjectKind: config.kind,
    label: config.label,
    pinsSubmissionPolicy: true,
    triggers: ["on_submit"],
    actions: ["notify", "send_email"],
    statuses: config.statuses.map((value) => ({ value, label: value })),
    fields: [
      ...config.fields.map(({ column: _column, ...field }) => field),
      { key: "status", label: "Status", type: "enum" },
      { key: "commandAction", label: "Command", type: "text" },
    ],
  };
  async function load(id: string) {
    const pairs = config.fields.flatMap((field) => [
      sql`${field.key}::text`,
      field.type === "number"
        ? sql`s.${sql.identifier(field.column)}::text`
        : sql`s.${sql.identifier(field.column)}`,
    ]);
    const row = (
      await db.execute<{
        status: string;
        maker: string | null;
        facts: Record<string, unknown>;
        fingerprint: string;
        makers: string[] | null;
      }>(
        sql`
   select (${config.statusSql ?? sql`s.${sql.identifier(config.statusColumn)}`})::text as status,s.${sql.identifier(config.makerColumn ?? "created_by")} as maker,
    jsonb_build_object(${sql.join(pairs, sql`, `)}) as facts,${config.makerIds ?? sql`null::text[]`} as makers,
    ${config.fingerprint ?? sql`public.flow_command_record_fingerprint(to_jsonb(s),${config.integrity ?? sql`null`})`} as fingerprint
   from ${sql.identifier(config.table)} s where s.id=${id} and (${config.where ?? sql`true`})`,
        "objects",
      )
    )[0];
    return row
      ? {
          values: {
            id,
            ...row.facts,
            status: row.status,
            approvalFingerprint: row.fingerprint,
          },
          makerUserId: row.maker,
          makerUserIds: row.makers ?? [],
          submitterUserId: row.maker,
        }
      : null;
  }
  return defineTableSubjectAdapter({
    nativeCommandApproval: true,
    subjectKind: config.kind,
    profile,
    scope: config.scope,
    permissions: config.permissions,
    releaseViaHandler: true,
    ...(config.decisionPermissions
      ? {
          async decisionPermission(id: string, actorId: string) {
            const row = (
              await db.execute<{ org_id: string }>(
                sql`select org_id from ${sql.identifier(config.table)} where id=${id}`,
                "objects",
              )
            )[0];
            if (!row) return null;
            for (const permission of config.decisionPermissions!)
              if (await actorHasPermission(db, row.org_id, actorId, permission)) return permission;
            return null;
          },
        }
      : {}),
    loadContext: load,
    async getStatus(id) {
      return (await load(id))?.values.status ?? null;
    },
    label(id, values) {
      return `${config.label} · ${String(values.name ?? values.number ?? id)}`;
    },
    deepLink: (id) => approvalRequestHref(config.kind, id),
    async changeStatus() {
      throw new FlowDispatchError(
        "Use the native submission and Flow gates to decide this record.",
      );
    },
    async setField() {
      throw new FlowDispatchError("Withdraw the pending command before changing its terms.");
    },
    async releaseApproval(subjectId, outcome, ctx, detail, run) {
      const command = run?.dispatchValues?.command;
      if (!command || typeof command !== "object" || Array.isArray(command))
        throw new FlowDispatchError(
          "This submission has no frozen native command. Withdraw and submit the current record again.",
        );
      await releaseFlowApproval({
        subjectKind: config.kind,
        subjectId,
        outcome,
        ctx,
        comment: detail?.comment,
        approvalRunId: run?.id,
        command: command as Record<string, unknown>,
      });
    },
  });
}
