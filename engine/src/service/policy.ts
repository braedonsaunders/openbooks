/**
 * The effective-dated service dispatch policy: customer notices (opt-in),
 * the default arrival window and visit length, response targets by
 * priority and the agreement horizon. A change appends a version from its
 * effective date, so a change never reinterprets visits already promised.
 * Missing configuration refuses by name; nothing falls back to a default.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  lockServiceFeature,
  requireDate,
  requiredText,
  requireOne,
  auditService,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";

export type ServiceDispatchPolicy = {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly notifyArrivalWindow: boolean;
  readonly notifyEnRoute: boolean;
  readonly arrivalWindowMinutes: number;
  readonly defaultVisitMinutes: number;
  readonly urgentResponseHours: number | null;
  readonly highResponseHours: number | null;
  readonly normalResponseHours: number | null;
  readonly lowResponseHours: number | null;
  readonly agreementHorizonDays: number;
  readonly reason: string;
  readonly createdAt: string;
};

const COLUMNS = sql`id, effective_from::text as "effectiveFrom", notify_arrival_window as "notifyArrivalWindow", notify_en_route as "notifyEnRoute",
  arrival_window_minutes as "arrivalWindowMinutes", default_visit_minutes as "defaultVisitMinutes",
  urgent_response_hours as "urgentResponseHours", high_response_hours as "highResponseHours",
  normal_response_hours as "normalResponseHours", low_response_hours as "lowResponseHours",
  agreement_horizon_days as "agreementHorizonDays", reason,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

/** The policy version in force on a date, or null when none starts on or before it. */
export async function policyOn(
  orgId: string,
  onDate: string,
): Promise<ServiceDispatchPolicy | null> {
  return (
    (
      await db.execute<ServiceDispatchPolicy>(
        sql`select ${COLUMNS} from service_dispatch_policies
    where org_id = ${orgId} and effective_from <= ${onDate} order by effective_from desc limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

/** The policy in force, refusing when the organization has not configured one. */
export async function requirePolicy(orgId: string, onDate: string): Promise<ServiceDispatchPolicy> {
  const policy = await policyOn(orgId, onDate);
  if (!policy) {
    throw new ServiceError(`No service dispatch policy is in force on ${onDate}.`, {
      code: "service_policy_missing",
      remedy:
        "Add a dispatch policy in Setup → Service dispatch, effective on or before this date, to set arrival windows, visit length and response targets.",
    });
  }
  return policy;
}

export async function listPolicies(orgId: string): Promise<ServiceDispatchPolicy[]> {
  return await db.execute<ServiceDispatchPolicy>(
    sql`select ${COLUMNS} from service_dispatch_policies
    where org_id = ${orgId} order by effective_from desc`,
    "objects",
  );
}

export interface PolicyVersionInput {
  readonly effectiveFrom: string;
  readonly notifyArrivalWindow: boolean;
  readonly notifyEnRoute: boolean;
  readonly arrivalWindowMinutes: number;
  readonly defaultVisitMinutes: number;
  readonly urgentResponseHours: number | null;
  readonly highResponseHours: number | null;
  readonly normalResponseHours: number | null;
  readonly lowResponseHours: number | null;
  readonly agreementHorizonDays: number;
  readonly reason: string;
}

function wholeNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  optional: boolean,
): number | null {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ServiceError(`${field} must be a whole number from ${minimum} to ${maximum}.`, {
      code: "service_invalid",
    });
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new ServiceError(`${field} must be on or off.`, { code: "service_invalid" });
  return value;
}

/**
 * Append a dispatch policy version. Organization-wide configuration, so the
 * caller needs Setup management with unrestricted legal-entity access.
 */
export async function savePolicyVersion(
  actor: ServiceActor & { input: PolicyVersionInput },
): Promise<ServiceDispatchPolicy> {
  const input = actor.input;
  const effectiveFrom = requireDate(input.effectiveFrom, "Effective date");
  const values = {
    notifyArrivalWindow: bool(input.notifyArrivalWindow, "Arrival window notices"),
    notifyEnRoute: bool(input.notifyEnRoute, "On-my-way notices"),
    arrivalWindowMinutes: wholeNumber(
      input.arrivalWindowMinutes,
      "Arrival window",
      15,
      720,
      false,
    )!,
    defaultVisitMinutes: wholeNumber(
      input.defaultVisitMinutes,
      "Default visit length",
      5,
      1440,
      false,
    )!,
    urgentResponseHours: wholeNumber(
      input.urgentResponseHours,
      "Urgent response target",
      1,
      8760,
      true,
    ),
    highResponseHours: wholeNumber(input.highResponseHours, "High response target", 1, 8760, true),
    normalResponseHours: wholeNumber(
      input.normalResponseHours,
      "Normal response target",
      1,
      8760,
      true,
    ),
    lowResponseHours: wholeNumber(input.lowResponseHours, "Low response target", 1, 8760, true),
    agreementHorizonDays: wholeNumber(
      input.agreementHorizonDays,
      "Agreement horizon",
      7,
      366,
      false,
    )!,
    reason: requiredText(input.reason, "Reason", 2000),
  };
  return withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const allowed = await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      null,
      "admin.setup.manage",
    );
    if (allowed !== null) {
      throw new ServiceError("The dispatch policy applies to every legal entity.", {
        status: 403,
        code: "service_forbidden",
        remedy: "Ask an administrator with access to every legal entity to change it.",
      });
    }
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`service-policy:${actor.orgId}`}, 0))`,
    );
    const row = requireOne(
      await db.execute<ServiceDispatchPolicy>(
        sql`insert into service_dispatch_policies
      (org_id, effective_from, notify_arrival_window, notify_en_route, arrival_window_minutes, default_visit_minutes,
       urgent_response_hours, high_response_hours, normal_response_hours, low_response_hours, agreement_horizon_days, reason, created_by)
      values (${actor.orgId}, ${effectiveFrom}, ${values.notifyArrivalWindow}, ${values.notifyEnRoute}, ${values.arrivalWindowMinutes}, ${values.defaultVisitMinutes},
       ${values.urgentResponseHours}, ${values.highResponseHours}, ${values.normalResponseHours}, ${values.lowResponseHours}, ${values.agreementHorizonDays}, ${values.reason}, ${actor.actorId})
      returning ${COLUMNS}`,
        "objects",
      ),
      "The dispatch policy",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_dispatch_policies",
      rowId: row.id,
      action: "insert",
      actorId: actor.actorId,
      after: row,
      reason: values.reason,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}
