import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { declaredPayrollFilings } from "@openbooks/engine/payroll/filing-registry";
import {
  findSameSpecificityConflict,
  pinnedIds,
  targetingSpecificity,
} from "@openbooks/engine/hrm/leave-math";
import { SetupWriteRefusal, type SetupTransaction } from "./write-shared";

/**
 * Duplicate conflicts stay typed: `code` drives the drawer's
 * localized copy while `error` reads as user language for every other
 * surface of this shared layer (assistant/MCP tools, API consumers) — never
 * a bare code string.
 */
export function duplicateConflict(entityKey: string): {
  status: 409;
  body: { error: string; code: "duplicate" };
} {
  const error =
    entityKey === "fx-rates" || entityKey === "consolidated-fx-rates"
      ? "An exchange rate for this date, currency pair and type already exists."
      : "This record already exists.";
  return { status: 409, body: { error, code: "duplicate" } };
}

/**
 * The filing-account duplicate names the row the server sees.
 *
 * Account numbers are unique across the whole organization — every filing
 * program (a federal EIN and a state SUI account share one namespace), every
 * legal entity, and archived rows too — enforced by the storage UNIQUE on
 * (org_id, account_number) and mirrored by the natural-key preflight. The
 * filing-accounts list can legitimately not show that row: it may belong to
 * another program tab, another legal entity, or the archived set. A bare
 * "already exists" then reads as a contradiction ("the list shows only the
 * EIN row"), so the refusal carries the conflicting row's program, state,
 * entity and archived state, with the edit-or-reactivate remedy. Falls back
 * to the generic conflict when the row vanishes under the read.
 */
export async function filingAccountDuplicateConflict(
  orgId: string,
  accountNumber: string,
): Promise<{ status: 409; body: { error: string; code: "duplicate" } }> {
  const row = (
    await db.execute(
      sql`
    select fa.account_number, fa.name, fa.country, fa.program_type, fa.state_code,
           fa.is_active, s.name as subsidiary_name
      from payroll_filing_accounts fa
      left join subsidiaries s on s.id = fa.subsidiary_id and s.org_id = fa.org_id
     where fa.org_id = ${orgId} and fa.account_number = ${accountNumber}
     order by fa.created_at limit 1`,
      "objects",
    )
  )[0] as
    | {
        account_number: string;
        name: string;
        country: string;
        program_type: string;
        state_code: string | null;
        is_active: boolean;
        subsidiary_name: string | null;
      }
    | undefined;
  if (!row) return duplicateConflict("payroll-filing-accounts");
  let program = row.program_type;
  for (const pack of declaredPayrollFilings()) {
    const declared = pack.programTypes.find((programType) => programType.key === row.program_type);
    if (declared) {
      program = declared.label;
      break;
    }
  }
  const scope = [row.country, row.state_code, row.subsidiary_name ?? "all legal entities"]
    .filter(Boolean)
    .join(", ");
  const remedy = row.is_active
    ? `Edit "${row.name}" in Payroll Setup → Filing accounts instead of creating a second row.`
    : `"${row.name}" is archived: reactivate it in Payroll Setup → Filing accounts instead of creating a second row.`;
  return {
    status: 409,
    body: {
      error:
        `A filing account with number "${row.account_number}" already exists: "${row.name}" (${program}${scope ? `, ${scope}` : ""}). ` +
        `Account numbers are unique across every filing program and legal entity in this organization, including archived accounts. ` +
        remedy,
      code: "duplicate",
    },
  };
}

/**
 * Overlap conflicts stay typed: a GiST exclusion rejection
 * (SQLSTATE 23P01) must never echo Postgres constraint text to the drawer.
 * `code` drives the drawer's localized copy while `error` reads as user
 * language for every other surface of this shared layer.
 */
export function overlapConflict(entityKey: string): {
  status: 409;
  body: { error: string; code: "overlap" };
} {
  const error =
    entityKey === "income-tax-rates"
      ? "An active rate already covers this jurisdiction for this period."
      : entityKey === "leave-policies"
        ? "Another policy already covers this leave type and scope for these dates — close its window or deactivate it before saving."
        : entityKey === "business-calendars"
          ? "A calendar already covers this organization or subsidiary for these dates — close its window (set its effective-to) or deactivate it before saving."
          : entityKey === "aging-bucket-policies"
            ? "An aging policy already covers these dates — close its window (set its effective-to) or deactivate it before saving."
            : "This period overlaps an existing record.";
  return { status: 409, body: { error, code: "overlap" } };
}

/**
 * Leave-policy targeting guard: same-type policy writes serialize on a
 * (org, leave type) advisory lock, then a resulting active window that
 * overlaps an active same-type policy of the same specificity class with
 * intersecting employee/classification sets is refused naming the
 * conflicting policy (409 overlap, the drawer code). Different classes
 * overlap freely and resolve by specificity; the wildcard-only storage
 * exclusion backstops the concurrent-writer race for untargeted windows.
 * Runs inside the write transaction on create and on every update/end
 * path (window, target, or active-flag edits, reactivations), so
 * concurrent writers observe each other's committed rows.
 */
export async function guardLeavePolicyWindow(
  tx: SetupTransaction,
  orgId: string,
  window: {
    leaveTypeId: string;
    appliesTo: Record<string, unknown> | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    isActive: boolean;
  },
  ignoreId: string | null,
): Promise<void> {
  if (!window.isActive) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"openbooks:leave-policy:" + orgId + ":" + window.leaveTypeId}, 0))`,
  );
  const rows = await tx.execute<{
    id: string;
    applies_to: unknown;
    effective_from: string;
    effective_to: string | null;
  }>(
    sql`
    select id, applies_to, effective_from::text as effective_from, effective_to::text as effective_to
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${window.leaveTypeId} and is_active
       and effective_from <= ${window.effectiveTo ?? "9999-12-31"}
       and (effective_to is null or effective_to >= ${window.effectiveFrom})
       and (${ignoreId}::uuid is null or id <> ${ignoreId}::uuid)
  `,
    "objects",
  );
  const applies = window.appliesTo ?? {};
  const pins = (stored: unknown) =>
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const candidate = {
    employerSubsidiaryId: (applies.employer_subsidiary_id as string | null) ?? null,
    departmentId: (applies.department_id as string | null) ?? null,
    employmentIds: pinnedIds(applies.employment_ids as string[] | null | undefined),
    classificationIds: pinnedIds(applies.classification_ids as string[] | null | undefined),
    effectiveFrom: window.effectiveFrom,
    effectiveTo: window.effectiveTo,
  };
  const conflict = findSameSpecificityConflict(
    candidate,
    rows.map((row) => {
      const stored = pins(row.applies_to);
      return {
        id: String(row.id),
        employerSubsidiaryId: (stored.employer_subsidiary_id as string | null) ?? null,
        departmentId: (stored.department_id as string | null) ?? null,
        employmentIds: pinnedIds(stored.employment_ids as string[] | null | undefined),
        classificationIds: pinnedIds(stored.classification_ids as string[] | null | undefined),
        effectiveFrom: String(row.effective_from).slice(0, 10),
        effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
      };
    }),
  );
  if (conflict) {
    const span = `${conflict.effectiveFrom} to ${conflict.effectiveTo ?? "open"}`;
    // The all-wildcard class keeps the historic scope wording; targeted
    // classes name the dimension they collide on.
    const covers =
      targetingSpecificity(candidate) === 0
        ? `Policy ${conflict.id} already covers this leave type and scope over ${span}`
        : `Policy ${conflict.id} already covers these employees and classifications over ${span} at the same specificity`;
    throw new SetupWriteRefusal(
      `${covers} — close its window or deactivate it before saving.`,
      409,
      "overlap",
    );
  }
}
