/** Shared equity internals: the feature fence, authority, the legal-entity lock, audit and reasons. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { memoizedRead } from "../platform/read-memo.ts";
import { isUuid } from "../platform/uuid.ts";
import { EQUITY_FEATURE_KEY, EquityError, equityError, fig } from "./errors.ts";

export type EquityPermission = "equity.read" | "equity.manage" | "equity.approve";

const featureOff = (): EquityError => equityError("featureOff");

/** Hold the organization's feature fence and refuse when the feature is off, so a disable and a write serialize. */
export async function assertEquityFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(runner, orgId);
  if (!(await lockAndCheckOrgFeature(runner, orgId, EQUITY_FEATURE_KEY))) throw featureOff();
}

/** Read-path feature check (no fence: reads change nothing). */
export async function assertEquityReadable(orgId: string): Promise<void> {
  if (
    !(await memoizedRead(`equity-readable:${orgId}`, () =>
      orgFeatureEnabled(orgId, EQUITY_FEATURE_KEY),
    ))
  )
    throw featureOff();
}

function forbidden(permission: EquityPermission, scoped: boolean): EquityError {
  return equityError(scoped ? "forbiddenForEntity" : "forbidden", {
    permission: fig.text(permission),
  });
}

/**
 * Command authority: the actor's live grants must hold the duty and reach
 * the legal entity. Grants are pinned for the rest of the transaction.
 */
export async function requireEquityAuthority(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  permission: EquityPermission,
): Promise<void> {
  try {
    await lockActorCommandAuthority(runner, orgId, actorId, subsidiaryId, permission);
  } catch {
    throw forbidden(permission, true);
  }
}

/** Read authority: the permission and, for a named legal entity, access to it. Returns the reachable entities (null: all). */
export async function requireEquityReader(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
): Promise<ReadonlySet<string> | null> {
  const allowed = await memoizedRead(`equity-reader:${orgId}:${actorId}`, async () => {
    if (!(await actorHasPermission(runner, orgId, actorId, "equity.read")))
      throw forbidden("equity.read", false);
    return actorAllowedSubsidiaryIds(runner, orgId, actorId) as Promise<ReadonlySet<string> | null>;
  });
  if (subsidiaryId !== null && allowed !== null && !allowed.has(subsidiaryId)) {
    throw equityError("entityOutsideAccess");
  }
  return allowed;
}

/**
 * Serialize every equity write of one legal entity. Validation reads the
 * entity's whole history (outstanding shares, pools, vesting), so the lock
 * is taken before that read and held to commit.
 */
export async function lockEquityEntity(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<void> {
  await runner.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:equity:${orgId}:${subsidiaryId}`}, 0))`,
  );
}

export interface LegalEntity {
  id: string;
  name: string;
  currency: string;
}

/** An active legal entity of the organization with its functional currency; anything else refuses. */
export async function loadLegalEntity(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<LegalEntity> {
  return memoizedRead(`equity-legal-entity:${orgId}:${subsidiaryId}`, () =>
    readLegalEntity(runner, orgId, subsidiaryId),
  );
}

async function readLegalEntity(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<LegalEntity> {
  if (!isUuid(subsidiaryId)) {
    throw equityError("entityInvalid", {}, { field: "subsidiaryId" });
  }
  const row = (
    await runner.execute<{
      id: string;
      name: string;
      currency: string | null;
      is_active: boolean;
      is_elimination: boolean;
    }>(
      sql`
    select id, name, nullif(trim(base_currency), '') as currency, is_active, is_elimination
      from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`,
      "objects",
    )
  )[0];
  if (!row || !row.is_active || row.is_elimination) {
    throw equityError("entityInactive", {}, { field: "subsidiaryId" });
  }
  if (!row.currency) {
    throw equityError("entityCurrencyMissing", { entity: fig.text(row.name) });
  }
  return { id: row.id, name: row.name, currency: row.currency };
}

/** ISO minor-unit exponent of a currency; an unknown code refuses by name. */
export async function currencyExponent(runner: SqlExecutor, currency: string): Promise<number> {
  const row = (
    await runner.execute<{ minor_units: number }>(
      sql`select minor_units from currencies where code = ${currency}`,
      "objects",
    )
  )[0];
  const exponent = row?.minor_units;
  if (exponent === undefined || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw equityError("currencyUnknown", { currency: fig.text(currency) });
  }
  return exponent;
}

/** One audit_log row; a write that stores nothing is a failure. */
export async function writeEquityAudit(
  runner: SqlExecutor,
  input: {
    orgId: string;
    table: string;
    rowId: string;
    action: string;
    actorId: string | null;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  const written = await runner.execute<{ id: string }>(
    sql`
    insert into audit_log (id, org_id, table_name, row_id, action, changes, actor_id)
    values (${randomUUID()}, ${input.orgId}, ${input.table}, ${input.rowId}, ${input.action},
      ${JSON.stringify(input.changes, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}::jsonb, ${input.actorId})
    returning id`,
    "objects",
  );
  if (written.length !== 1) {
    throw equityError("auditUnwritten");
  }
}

/** What a required reason explains, as the refusal names it. */
export type ReasonSubject =
  | "classAmendment"
  | "split"
  | "reserveChange"
  | "mfnElection"
  | "mfnReversal"
  | "roundAmendment"
  | "roundVoid"
  | "accountPolicy"
  | "forfeit"
  | "expire"
  | "cancel"
  | "repurchase"
  | "void"
  | "reverse"
  | "withdrawal";

/** A reason's bounds, the schema's own. */
export const REASON_LENGTH = { min: 5, max: 2000 } as const;

/** A required reason: trimmed, 5 to 2000 characters. */
export function requireReason(reason: unknown, subject: ReasonSubject): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < REASON_LENGTH.min || text.length > REASON_LENGTH.max) {
    throw equityError(
      "reasonRequired",
      {
        subject: fig.choice(subject),
        min: fig.count(REASON_LENGTH.min),
        max: fig.count(REASON_LENGTH.max),
      },
      { field: "reason" },
    );
  }
  return text;
}

/** Map a unique-key violation to a named conflict; anything else propagates unchanged. */
export function conflictOf(error: unknown, constraint: string, conflict: EquityError): never {
  const chain: unknown[] = [];
  for (
    let cursor: unknown = error;
    cursor && chain.length < 5;
    cursor = (cursor as { cause?: unknown }).cause
  )
    chain.push(cursor);
  if (
    chain.some(
      (entry) =>
        (entry as { code?: unknown }).code === "23505" &&
        String((entry as { constraint?: unknown }).constraint ?? "") === constraint,
    )
  )
    throw conflict;
  throw error;
}
