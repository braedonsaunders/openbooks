import { sql } from "drizzle-orm";
import {
  checklistDocumentSchema,
  checklistStepDesignSchema,
  type ChecklistDocument,
  type ChecklistStepDesign,
  type LogicRule,
} from "@openbooks/forms-core";
import { db } from "../platform/db.ts";

type Maps = {
  steps: ReadonlyMap<string, string>;
  parties: ReadonlyMap<string, string>;
  subsidiaries: ReadonlyMap<string, string>;
  departments: ReadonlyMap<string, string>;
  accounts: ReadonlyMap<string, string>;
};
function mapped(value: unknown, ids: ReadonlyMap<string, string>, label: string): string | null {
  if (value === null) return null;
  const result = typeof value === "string" ? ids.get(value.toLowerCase()) : undefined;
  if (!result)
    throw new Error(`${label}: referenced identity has no counterpart in the target organization`);
  return result;
}
function condition(rule: LogicRule, ids: Maps): LogicRule {
  if ("rules" in rule) return { ...rule, rules: rule.rules.map((r) => condition(r, ids)) };
  if ("rule" in rule) return { ...rule, rule: condition(rule.rule, ids) };
  const map =
    rule.field === "employerSubsidiaryId"
      ? ids.subsidiaries
      : rule.field === "departmentId"
        ? ids.departments
        : null;
  if (!map || !("value" in rule)) return rule;
  return {
    ...rule,
    value: Array.isArray(rule.value)
      ? rule.value.map((v) => mapped(v, map, "Checklist condition"))
      : mapped(rule.value, map, "Checklist condition"),
  } as LogicRule;
}
export function remapChecklistDesign(value: ChecklistStepDesign, ids: Maps): ChecklistStepDesign {
  return {
    ...value,
    dependencies: value.dependencies.map((id) => mapped(id, ids.steps, "Checklist prerequisite")!),
    condition: value.condition ? condition(value.condition, ids) : null,
    form: value.form
      ? {
          ...value.form,
          sections: value.form.sections.map((section) => ({
            ...section,
            fields: section.fields.map((field) => {
              const map =
                field.type === "party"
                  ? ids.parties
                  : field.type === "gl_account"
                    ? ids.accounts
                    : null;
              if (
                !map ||
                field.defaultValue?.kind !== "literal" ||
                field.defaultValue.value === null ||
                field.defaultValue.value === ""
              )
                return field;
              return {
                ...field,
                defaultValue: {
                  kind: "literal" as const,
                  value: mapped(field.defaultValue.value, map, "Checklist form default"),
                },
              };
            }),
          })),
        }
      : null,
  };
}
export function remapChecklistDocument(value: ChecklistDocument, ids: Maps): ChecklistDocument {
  return {
    ...value,
    appliesTo: {
      employerSubsidiaryId: mapped(
        value.appliesTo.employerSubsidiaryId,
        ids.subsidiaries,
        "Checklist employer",
      ),
      departmentId: mapped(value.appliesTo.departmentId, ids.departments, "Checklist department"),
    },
    steps: value.steps.map((step) => ({
      ...step,
      id: mapped(step.id, ids.steps, "Checklist step")!,
      ownerPartyId: mapped(step.ownerPartyId, ids.parties, "Checklist owner"),
      design: remapChecklistDesign(step.design, ids),
    })),
  };
}
/** Preserve full-copy evidence while rebasing declared party and account references. */
export function remapChecklistResponse(
  value: Record<string, unknown> | null,
  design: ChecklistStepDesign,
  ids: Maps,
): Record<string, unknown> | null {
  if (!value || !design.form) return value;
  const after = structuredClone(value);
  for (const section of design.form.sections) {
    const sources = section.repeating ? after[section.id] : [after];
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      const row = source as Record<string, unknown>;
      for (const field of section.fields) {
        const map =
          field.type === "party" ? ids.parties : field.type === "gl_account" ? ids.accounts : null;
        if (!map || row[field.id] === undefined || row[field.id] === null || row[field.id] === "")
          continue;
        row[field.id] = mapped(row[field.id], map, `Checklist evidence "${field.label}"`);
      }
    }
  }
  return after;
}
/** Rebase intrinsic draft identities deterministically; foreign references require a proven copied row. */
export async function rebaseChecklistReferences(args: {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  copiedTables: ReadonlySet<string>;
}): Promise<void> {
  const tables = [
    "hrm_process_templates",
    "hrm_process_template_versions",
    "hrm_process_template_steps",
    "hrm_process_steps",
  ].filter((table) => args.copiedTables.has(table));
  if (!tables.length) return;
  const counterpart = async (table: string): Promise<Map<string, string>> => {
    const rows = (
      await db.execute<{ source_id: string; target_id: string }>(
        sql`select source.id as source_id,target.id as target_id from ${sql.identifier(table)} source join ${sql.identifier(table)} target on target.id=ob_rebase(source.id,${args.seed}::uuid) and target.org_id=${args.sandboxOrgId} where source.org_id=${args.productionOrgId}`,
      )
    ).rows;
    return new Map(rows.map((r) => [r.source_id, r.target_id]));
  };
  const ids: Maps = {
    steps: await counterpart("hrm_process_template_steps"),
    parties: await counterpart("parties"),
    subsidiaries: await counterpart("subsidiaries"),
    departments: await counterpart("departments"),
    accounts: await counterpart("accounts"),
  };
  for (const table of tables) {
    const field =
      table === "hrm_process_templates"
        ? "draft_document"
        : table === "hrm_process_template_versions"
          ? "document"
          : "design";
    const rows = (
      await db.execute<{ id: string; payload: unknown; response?: Record<string, unknown> | null }>(
        sql`select id,${sql.identifier(field)} as payload,${table === "hrm_process_steps" ? sql`response` : sql`null`} as response from ${sql.identifier(table)} where org_id=${args.sandboxOrgId} and ${sql.identifier(field)} is not null order by id for update`,
      )
    ).rows;
    for (const row of rows) {
      let after: unknown;
      if (field === "design")
        after = remapChecklistDesign(checklistStepDesignSchema.parse(row.payload), ids);
      else {
        const document = checklistDocumentSchema.parse(row.payload);
        const intrinsic = (
          await db.execute<{ source_id: string; target_id: string }>(
            sql`select value as source_id,ob_rebase(value::uuid,${args.seed}::uuid)::text as target_id from jsonb_array_elements_text(${JSON.stringify(document.steps.map((s) => s.id))}::jsonb) as ids(value)`,
          )
        ).rows;
        const steps = new Map([
          ...ids.steps,
          ...intrinsic.map((r) => [r.source_id, r.target_id] as const),
        ]);
        after = remapChecklistDocument(document, { ...ids, steps });
      }
      const response =
        table === "hrm_process_steps"
          ? remapChecklistResponse(
              row.response ?? null,
              checklistStepDesignSchema.parse(row.payload),
              ids,
            )
          : null;
      const updated = (
        await db.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(field)}=${JSON.stringify(after)}::jsonb${table === "hrm_process_steps" ? sql`,response=${JSON.stringify(response)}::jsonb` : sql``} where org_id=${args.sandboxOrgId} and id=${row.id} returning id`,
        )
      ).rows;
      if (updated.length !== 1)
        throw new Error(
          "The sandbox checklist definition changed during rebasing; retry the sandbox refresh.",
        );
      await db.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${args.sandboxOrgId},${table},${row.id},'update',${JSON.stringify({ mode: "sandbox_json_reference_rebase", before: { [field]: row.payload, ...(table === "hrm_process_steps" ? { response: row.response } : {}) }, after: { [field]: after, ...(table === "hrm_process_steps" ? { response } : {}) } })}::jsonb,null)`,
      );
    }
  }
}
