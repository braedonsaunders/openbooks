import "server-only";
import { uuidId } from "../api/json-schema";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import { updateFxRate } from "@openbooks/engine/fx/currencies";
import { db } from "@openbooks/engine/platform/db";
import { defaultLevyExclusionsForNewComponent } from "@openbooks/engine/payroll/packs";
import { CANONICAL_RATING_KEYS } from "@openbooks/engine/hrm/recruiting/kits";
import {
  SETUP_ENTITY_BY_KEY,
  resolveSetupEntityGate,
  setupEntityForFeatureState,
  setupEntitySubsidiaryField,
  setupEntitySubsidiaryReferenceFields,
  type SetupEntity,
} from "./registry";
import { permissionSetCovers } from "../permissions";
import { UNRESTRICTED_SCOPE_REQUIRED } from "../subsidiaries";
import { coerceBoolean, describeDbError, pgErrorCode } from "./coerce";
import { resolvedFeatureState } from "../features";

// Drizzle expands bare JS arrays inside sql templates into SQL expressions.
// A PostgreSQL array column instead needs one bound driver array parameter.
export const bindSetupValue = (value: unknown) => (Array.isArray(value) ? sql.param(value) : value);

/** The acting admin: org, user id (stamped on rows + audit), and permissions
 *  (extension settings scope themselves by permission). */
export type SetupActor = {
  orgId: string;
  id: string;
  permissions: Iterable<string>;
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
};

/** Transport-neutral outcome: the HTTP status the route answers with and the
 *  JSON body. Adapters map it onto their wire. */
export type SetupWriteResult = { status: number; body: Record<string, unknown> };

export class SetupWriteRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

export function setupRefusalResult(error: SetupWriteRefusal): SetupWriteResult {
  return {
    status: error.status,
    body: {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.remedy ? { remedy: error.remedy } : {}),
    },
  };
}

export function typedSetupRefusal(error: unknown): SetupWriteRefusal | null {
  if (!(error instanceof Error)) return null;
  const source = error as Error & { status?: unknown; code?: unknown; remedy?: unknown };
  if (
    typeof source.status !== "number" ||
    !Number.isInteger(source.status) ||
    source.status < 400 ||
    source.status > 499
  )
    return null;
  return new SetupWriteRefusal(
    error.message,
    source.status,
    typeof source.code === "string" ? source.code : undefined,
    typeof source.remedy === "string" ? source.remedy : undefined,
  );
}

export function setupDomainRefusal(error: unknown): SetupWriteResult | null {
  const refusal = typedSetupRefusal(error);
  return refusal ? setupRefusalResult(refusal) : null;
}

/**
 * A database failure raised while a write is being checked (a value the
 * check casts that the column cannot hold, a lock or constraint the check
 * reads) answers 400 with the Postgres cause. Left to escape it becomes an
 * empty 500 that the drawer can only report as "Save failed".
 */
export function integrityDatabaseRefusal(error: unknown): SetupWriteResult | null {
  return pgErrorCode(error) ? { status: 400, body: { error: describeDbError(error) } } : null;
}

export type SetupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function setupScopeRefusal(actor: SetupActor, entity: SetupEntity): SetupWriteResult | null {
  return actor.allowedSubsidiaryIds !== undefined &&
    actor.allowedSubsidiaryIds !== null &&
    !setupEntitySubsidiaryField(entity) &&
    setupEntitySubsidiaryReferenceFields(entity).length === 0
    ? { status: 403, body: { error: UNRESTRICTED_SCOPE_REQUIRED } }
    : null;
}

export async function savePayComponentEarningClassification(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  componentId: string,
  classification: {
    supplementalWageCategory?: unknown;
    statutoryReportingCategory?: unknown;
    statutoryExemptionCategory?: unknown;
  },
): Promise<void> {
  const result = await tx.execute(
    sql`
    update pay_component_earning_classifications
       set supplemental_wage_category = case when ${classification.supplementalWageCategory !== undefined}
             then ${classification.supplementalWageCategory == null ? null : String(classification.supplementalWageCategory)}
             else supplemental_wage_category end,
           statutory_reporting_category = case when ${classification.statutoryReportingCategory !== undefined}
             then ${classification.statutoryReportingCategory == null ? null : String(classification.statutoryReportingCategory)}
             else statutory_reporting_category end,
           statutory_exemption_category = case when ${classification.statutoryExemptionCategory !== undefined}
             then ${classification.statutoryExemptionCategory == null ? null : String(classification.statutoryExemptionCategory)}
             else statutory_exemption_category end
     where org_id = ${orgId} and pay_component_id = ${componentId}
    returning pay_component_id`,
    "objects",
  );
  if (!result.length) throw new Error("pay component classification is missing");
}

export const FX_RATE_COLUMNS = new Set(["rate", "current_rate", "average_rate", "historical_rate"]);

/** Compare values read from PostgreSQL with the normalized values produced by
 * the setup coercer. Money columns come back at their storage scale (for
 * example `70.0000`) while the decimal coercer deliberately emits the wider
 * setup scale (`70.0000000000`); those representations are the same rule. */
export function comparableSetupValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        /* text value */
      }
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const negative = trimmed.startsWith("-");
      const unsigned = negative ? trimmed.slice(1) : trimmed;
      const [rawWhole, fraction = ""] = unsigned.split(".");
      const whole = rawWhole ?? "";
      const normalized = `${whole.replace(/^0+(?=\d)/, "")}${fraction ? `.${fraction.replace(/0+$/, "")}` : ""}`;
      return negative && normalized !== "0" ? `-${normalized}` : normalized;
    }
    return trimmed;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function persistFxRateCols<T extends { column: string; value: unknown }>(cols: T[]): T[] {
  return cols.map((column) =>
    FX_RATE_COLUMNS.has(column.column)
      ? { ...column, value: updateFxRate({ rate: column.value }) }
      : column,
  );
}

/**
 * Bind a validated id list as ONE pg-array parameter. Drizzle expands a raw
 * JS array inside sql`` into a row constructor ($1, $2), so the list crosses
 * sql.param exactly once and node-postgres serializes it natively — request
 * values can never shape the statement text.
 */
export const uuidArrayParam = (ids: string[]) => sql.param(ids);

/** Boundary gate for request-supplied id lists: every entry must parse as the
 * shared uuidId schema before SQL sees it, so a malformed or hostile id is the
 * route's documented client error instead of PostgreSQL raising 22P02 outside
 * this handler's validation catch. */
export function hasNonUuidEntry(ids: unknown[]): boolean {
  return !ids.every((id) => uuidId.safeParse(id).success);
}

/** Reconcile a tax group's members join table to exactly `taxCodeIds`. */
export async function syncMembers(
  orgId: string,
  groupId: string,
  taxCodeIds: string[],
  runner: Pick<typeof db, "execute"> = db,
) {
  const clean = [...new Set(taxCodeIds.filter((v) => isUuid(v)))];
  await runner.execute(sql`
    delete from tax_group_members
     where tax_group_id = ${groupId}
       and exists (select 1 from tax_groups where id = ${groupId} and org_id = ${orgId})`);
  for (let i = 0; i < clean.length; i++) {
    await runner.execute(sql`
      insert into tax_group_members (tax_group_id, tax_code_id, sequence)
      select tg.id, ${clean[i]}, ${i + 1}
        from tax_groups tg
       where tg.id = ${groupId} and tg.org_id = ${orgId}`);
  }
}

/**
 * The entity a write is validated against, WITH its dynamic options resolved.
 *
 * `resolveDynamicSetupOptions` is the same resolution the render path applies
 * before handing the descriptor to the client, and the write path must use it
 * too or the two disagree about what a field accepts. They did: a field may
 * declare BOTH a static `options` list and a dynamic `optionsSource`, the
 * static list being (per dynamic-options.ts) "the fallback for any surface
 * that renders without resolving". The picker resolved and offered all
 * fourteen declared payroll countries; `coerceField`'s `select` check never
 * resolved and validated against the fallback, which is still the CA/US pair
 * from before the registry opened. So creating a German filing account sent a
 * correct `country: "DE"` and got 400 "country has an invalid value" — the
 * server refusing a code its own picker had offered. `programType` had the
 * same split (ca_rp/us_ein/us_state_sui statically, every declared pack's
 * program types dynamically).
 *
 * Resolving here means one source of truth for what a field accepts, so a
 * newly registered pack's countries and program types become writable with no
 * registry edit — which was the stated intent of `optionsSource` all along.
 */
export function resolveEntity(entityKey: string): SetupEntity | null {
  return SETUP_ENTITY_BY_KEY.get(entityKey) ?? null;
}

export function entityPermissionRefusal(
  actor: SetupActor,
  entity: SetupEntity,
): SetupWriteResult | null {
  if (
    !entity.writePermission ||
    permissionSetCovers(new Set(actor.permissions), entity.writePermission)
  )
    return null;
  return { status: 403, body: { error: "forbidden" } };
}

/**
 * The entity to VALIDATE a write against: the same descriptor, with its dynamic
 * options resolved.
 *
 * A field may declare BOTH a static `options` list and a dynamic
 * `optionsSource`, the static list being (per dynamic-options.ts) "the fallback
 * for any surface that renders without resolving". The RENDER path resolves and
 * offered all fourteen declared payroll countries; the write path did not, so
 * `coerceField`'s `select` check validated against the fallback — still the
 * CA/US pair from before the pack registry opened. Creating a German filing
 * account sent a correct `country: "DE"` and got 400 "country has an invalid
 * value": the server refusing a code its own picker had offered.
 *
 * Imported DYNAMICALLY and called LATE, after the read-only and permission
 * guards, for two reasons: dynamic-options is server-only and reaches into the
 * engine's pack registry, and a read-only entity must fail closed WITHOUT
 * loading it (web/lib/setup-route.test.ts pins that a currency mutation
 * answers 405 with zero database calls — a top-level import breaks it).
 */
export async function entityForValidation(
  entity: SetupEntity,
  orgId: string,
): Promise<SetupEntity> {
  if (!hasDynamicOptions(entity)) return entity;
  const { resolveDynamicSetupOptions, setupOptionsContext } = await import("./dynamic-options");
  return resolveDynamicSetupOptions(entity, await setupOptionsContext(orgId, entity));
}

/** Cheap, pure check so the dynamic import happens only where it is needed. */
export function hasDynamicOptions(entity: SetupEntity): boolean {
  return (entity.fields ?? []).some((field) => field.optionsSource != null);
}

/**
 * Shared CRUD feature fence: unknown/disabled entities refuse before any row
 * or book lock. The verdict comes from the one authoritative gate — the
 * preflight, every command, and the fenced write-transaction recheck all meet
 * here, so the any-of rule cannot drift between verbs. Call sites and their
 * order are unchanged: this stays the first refusal after the advisory locks.
 */
export async function setupEntityEnabled(
  entity: SetupEntity,
  orgId: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<boolean> {
  return resolveSetupEntityGate(entity, await resolvedFeatureState(orgId, executor)).enabled;
}

/** Hide Equipment-gated controls for writes, but keep an existing
 *  equipment_charge trigger coercible so editing other fields on that row
 *  does not rewrite the gated value as a new persist. */
export function writableSetupEntity(
  entity: SetupEntity,
  features: {
    multiSubsidiary: boolean;
    equipment: boolean;
    fieldTickets: boolean;
    einvoicing: boolean;
  },
): SetupEntity {
  const next = setupEntityForFeatureState(entity, features);
  // Pay schedules keep their subsidiary control coercible even while the
  // feature is off. `validateEntityIntegrity` governs that entity through
  // the dedicated engine rule, which validates the submitted id against the
  // org — and the onboarding wizard names the sole subsidiary on a
  // single-entity tenant. Dropping the field here would silently persist the
  // root default instead of the validated choice (and an unscoped row in a
  // tenant that later grows a second entity).
  const scoped =
    entity.key === "pay-schedules" && !features.multiSubsidiary
      ? {
          ...next,
          fields: [
            ...next.fields,
            ...entity.fields.filter((field) => field.ref === "subsidiaries"),
          ],
        }
      : next;
  if (features.equipment) return scoped;
  const trigger = entity.fields.find((field) => field.key === "trigger");
  if (!trigger?.options?.some((option) => option.value === "equipment_charge")) return scoped;
  return {
    ...scoped,
    fields: scoped.fields.map((field) =>
      field.key === "trigger" ? { ...field, options: trigger.options } : field,
    ),
  };
}

// HR-18 begin: create-time defaults for recruiting-depth Setup. A kit
// created without a declared scale rates on the full canonical scale —
// defaulted here (before coercion), because the generic stringArray
// coercion would otherwise store an empty list the storage CHECK refuses
// without naming the field. Present-but-empty stays empty so the
// integrity check below can refuse it by name.
export function foldRecruitingSetupCreate(
  entityKey: string,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey === "hrm-interview-kits" && rawBody.ratingScale === undefined) {
    return { ...rawBody, ratingScale: [...CANONICAL_RATING_KEYS] };
  }
  return rawBody;
}
// HR-18 end

// Create-time defaults for pay components. A deduction that does not state
// its protected-base membership starts outside it. Assessability is stored
// in its own effective-dated row, inserted with the component below.
export function foldPayComponentSetupCreate(
  entityKey: string,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== "pay-components") return rawBody;
  // A deduction created without stating its pool membership starts outside
  // the protected base (see the deduction chooser in the workforce entity):
  // disposable earnings are pay after deductions required by law.
  if (rawBody.kind === "deduction" && rawBody.includeInDisposableEarnings === undefined) {
    return { ...rawBody, includeInDisposableEarnings: false };
  }
  return rawBody;
}

export function defaultPayComponentProgramExclusions(rawBody: Record<string, unknown>): string[] {
  const supplied = rawBody.programExclusions;
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || !supplied.every((key) => typeof key === "string")) {
      throw new SetupWriteRefusal(
        "Program exclusions must be a list of payroll program keys.",
        400,
        "invalid_program_exclusions",
        "Select valid keys in the component statutory treatment fields.",
      );
    }
    return [...new Set(supplied)] as string[];
  }
  if (rawBody.kind !== "earning") return [];
  return (
    defaultLevyExclusionsForNewComponent({
      kind: "earning",
      taxable: rawBody.taxable === undefined ? true : coerceBoolean(rawBody.taxable),
      country: rawBody.country ? String(rawBody.country) : null,
      programExclusions: undefined,
    }) ?? []
  );
}

/**
 * Outcome of one ordered group of entity integrity rules: a refusal message,
 * `null` for an accepted write that ends validation, or INTEGRITY_CONTINUES
 * when no rule in the group decided and validation proceeds to the next group.
 */
export const INTEGRITY_CONTINUES: unique symbol = Symbol("setup integrity continues");
export type SetupIntegrityVerdict = string | null | typeof INTEGRITY_CONTINUES;
