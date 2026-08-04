import type { FlowSubjectAdapter } from "./types.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { DOCUMENT_FLOW_KINDS, documentSubjectProfile } from "./subject-profiles.ts";
import {
  BANK_ACCOUNT_SUBJECT_KIND,
  bankAccountSubjectProfile,
  bankAccountsFlowAdapter,
} from "./bank-accounts-adapter.ts";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import {
  BUDGET_SCENARIO_SUBJECT_KIND,
  budgetScenarioSubjectProfile,
  budgetScenariosFlowAdapter,
} from "./budget-scenarios-adapter.ts";
import {
  CLOSE_RUN_SUBJECT_KIND,
  closeRunSubjectProfile,
  closeRunsFlowAdapter,
} from "./close-runs-adapter.ts";
import {
  FIELD_TICKET_SUBJECT_KIND,
  fieldTicketSubjectProfile,
  fieldTicketsFlowAdapter,
} from "./field-tickets-adapter.ts";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * subjectKind → FlowSubjectAdapter. The gate-resume path and every dispatch site rebuild
 * the right adapter from a stored subjectKind string. The documents adapter
 * covers every document kind; party_bank_account is the first non-document
 * subject; future adapters
 * (custom record types, …) register here.
 */

const adapterCache = new Map<string, FlowSubjectAdapter>();

export function getFlowAdapter(subjectKind: string): FlowSubjectAdapter | null {
  if (subjectKind === BANK_ACCOUNT_SUBJECT_KIND) return bankAccountsFlowAdapter;
  if (subjectKind === BUDGET_SCENARIO_SUBJECT_KIND) return budgetScenariosFlowAdapter;
  if (subjectKind === CLOSE_RUN_SUBJECT_KIND) return closeRunsFlowAdapter;
  if (subjectKind === FIELD_TICKET_SUBJECT_KIND) return fieldTicketsFlowAdapter;
  if (!DOCUMENT_FLOW_KINDS.includes(subjectKind)) return null;
  let adapter = adapterCache.get(subjectKind);
  if (!adapter) {
    adapter = createDocumentsFlowAdapter(subjectKind);
    adapterCache.set(subjectKind, adapter);
  }
  return adapter;
}

/** Every subject kind flows can be authored over, with its profile (builder UI). */
export function listFlowSubjectProfiles(): FlowSubjectProfile[] {
  return [
    ...DOCUMENT_FLOW_KINDS.map((kind) => documentSubjectProfile(kind)),
    bankAccountSubjectProfile,
    budgetScenarioSubjectProfile,
    closeRunSubjectProfile,
    fieldTicketSubjectProfile,
  ];
}

type CustomFlowFieldRow = {
  key: string;
  label: string;
  field_type: string;
  config: { options?: string[] } | null;
};

/**
 * Tenant-aware authoring profile. Runtime adapters stay module-level and
 * deterministic; the builder/linter additionally need this org's custom
 * roles and active custom header fields so authors never type schema or IAM
 * identifiers by hand.
 */
export async function flowSubjectProfileForOrg(
  orgId: string,
  subjectKind: string,
): Promise<FlowSubjectProfile | null> {
  const base = listFlowSubjectProfiles().find((profile) => profile.subjectKind === subjectKind);
  if (!base) return null;

  const roleResult = (await db.execute(sql`
    select key from app_roles where org_id = ${orgId} order by name
  `)) as unknown as { rows: { key: string }[] };

  if (!DOCUMENT_FLOW_KINDS.includes(subjectKind)) {
    return { ...base, roles: roleResult.rows.map((role) => role.key) };
  }

  const fieldResult = (await db.execute(sql`
    select key, label, field_type, config
      from custom_field_defs
     where org_id = ${orgId} and target_table = 'documents'
       and (target_kind is null or target_kind = ${subjectKind}) and is_active
     order by sort_order, label
  `)) as unknown as { rows: CustomFlowFieldRow[] };
  const existing = new Set(base.fields.map((field) => field.key));
  const customFields = fieldResult.rows
    .filter((field) => !existing.has(field.key))
    .map((field) => ({
      key: field.key,
      label: field.label,
      type:
        field.field_type === "number" || field.field_type === "currency"
          ? ("number" as const)
          : field.field_type === "boolean"
            ? ("bool" as const)
            : field.field_type === "date"
              ? ("date" as const)
              : field.field_type === "select" || field.field_type === "multi_select"
                ? ("enum" as const)
                : ("text" as const),
      writable: true,
      ...(field.config?.options?.length
        ? { options: field.config.options.map((option) => ({ value: option, label: option })) }
        : {}),
    }));

  return {
    ...base,
    fields: [...base.fields, ...customFields],
    roles: roleResult.rows.map((role) => role.key),
  };
}
