import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { type ProfileChangePayload } from "./self-service/profile-schema.ts";
import { type BankChangePayload } from "./self-service/bank-schema.ts";
import { loadMyAddress } from "./self-service/self-read.ts";
import { HrmChangeRequestError, type ChangeRequestPayload } from "./change-requests-payload.ts";
import {
  type RequestRow,
  assertEmploymentStatusPayrollWindow,
  assertHistoricalStatusWindow,
} from "./change-requests-core.ts";
import {
  insertEmploymentChange,
  linkAppliedEvidence,
  bumpAggregateRevision,
  bumpGraphRevision,
} from "./change-requests-evidence.ts";
import { type DbInstant } from "./change-requests-apply-helpers.ts";
import {
  applyHire,
  applyHistoricalStatusObservation,
  applyEmploymentVersionChange,
} from "./change-requests-apply-employment.ts";
import {
  applyAssignmentChange,
  applyPositionAssignment,
} from "./change-requests-apply-assignment.ts";

// --- Application: one transaction, all-or-nothing ----------------------------

export async function applyApprovedRequest(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: ChangeRequestPayload;
  },
): Promise<void> {
  const { orgId, actorId, request, payload } = args;
  // Defer the closure-link FKs: the close-then-insert-then-evidence order
  // writes closed_by_change_id before its employment_changes event exists.
  // Every check still fires at commit — nothing is weakened, only ordered.
  await exec.execute(sql`
    set constraints worker_employment_versions_change_tenant_fkey,
                      employment_assignment_versions_change_tenant_fkey,
                      reporting_relationships_change_tenant_fkey deferred
  `);

  if (payload.kind === "status_change" && payload.historicalObservation) {
    await assertHistoricalStatusWindow(exec, orgId, request.employment_id, payload);
  } else if (payload.kind === "status_change" || payload.kind === "termination") {
    await assertEmploymentStatusPayrollWindow(
      exec,
      orgId,
      request.employment_id,
      payload.kind === "termination" ? payload.effectiveDate : payload.effectiveFrom,
      payload.kind === "termination" ? null : payload.effectiveTo,
    );
  }

  // (1) Re-read the aggregate under lock and refuse a stale proposal: the
  // live revision must still equal the authored expectation.
  const aggregate = (
    await exec.execute<{ revision: number }>(
      sql`
    select revision from worker_employments
     where org_id = ${orgId} and id = ${request.employment_id} for update
  `,
      "objects",
    )
  )[0];
  if (!aggregate) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the employment is gone — withdraw this request; a proposal about a deleted aggregate never applies",
    );
  }
  if (aggregate.revision !== request.expected_employment_revision) {
    throw new HrmChangeRequestError(
      "STALE_REVISION",
      `the employment changed since this proposal was written (expected revision ${request.expected_employment_revision}, live revision ${aggregate.revision}) — file a new request against the current revision`,
    );
  }
  const newRevision = aggregate.revision + 1;
  // Graph row first: the 0184 reporting cycle guard bumps hrm_graph_revisions
  // itself and refuses when the row is missing, so the row must exist before
  // any branch below writes reporting. The bump also serializes concurrent
  // appliers on other employments of the same graph.
  await bumpGraphRevision(exec, orgId);
  // One clock for the handoff: every recorded_until closed here equals the
  // recorded_at of its successor (seamless, no gap or overlap).
  const nowRow = (
    await exec.execute<{ now: DbInstant; now_iso: string }>(
      sql`
    select now() as now,
           to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now_iso
  `,
      "objects",
    )
  )[0];
  const recordedAt = nowRow?.now;
  const recordedAtIso = nowRow?.now_iso;
  if (!recordedAt || typeof recordedAtIso !== "string" || recordedAtIso.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the database clock is unreadable — retry the decision",
    );
  }

  // (1) is the aggregate re-read above; (2) the version writes with their
  // employment_changes event and (3) the approved → applied flip with the
  // evidence link (single-fire: only a still-approved row moves) land inside
  // each branch below — all in this one transaction.
  if (payload.kind === "hire") {
    await applyHire(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
      recordedAtIso,
    });
  } else if (payload.kind === "status_change" && payload.historicalObservation) {
    await applyHistoricalStatusObservation(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
    });
  } else if (payload.kind === "status_change" || payload.kind === "termination") {
    await applyEmploymentVersionChange(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
    });
  } else if (payload.kind === "position_assignment") {
    await applyPositionAssignment(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
      recordedAtIso,
    });
  } else if (payload.kind === "profile_change") {
    await applyProfileChange(exec, { orgId, actorId, request, payload, newRevision });
  } else if (payload.kind === "bank_change") {
    await applyBankChange(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
      recordedAtIso,
    });
  } else {
    await applyAssignmentChange(exec, {
      orgId,
      actorId,
      request,
      payload,
      newRevision,
      recordedAt,
    });
  }
}

/**
 * (f) Profile change: the person's own contact proposal lands on the
 * party row (and the profile address row) — never on an employment
 * version, which is why no version closes here. The edited party is the
 * bound employment's worker party re-resolved under the aggregate lock,
 * never a caller-supplied id. Scalars follow missing-untouched /
 * null-clears;
 * the address object fully replaces the profile address row (updated in
 * place, inserted when none exists). A proposal that changes nothing
 * refuses; the evidence is a profile_changed employment_changes event
 * with exact before-images, then the applied link and the revision bump —
 * all in the one approval transaction.
 */
async function applyProfileChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: ProfileChangePayload;
    newRevision: number;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision } = args;
  const aggregate = (
    await exec.execute<{ revision: number; worker_party_id: string }>(
      sql`
    select revision, worker_party_id from worker_employments
     where org_id = ${orgId} and id = ${request.employment_id} for update
  `,
      "objects",
    )
  )[0];
  if (!aggregate) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the employment is gone — withdraw this request; a proposal about a deleted aggregate never applies",
    );
  }
  const partyId = aggregate.worker_party_id;
  const before = (
    await exec.execute<{
      phone: string | null;
      email: string | null;
      emergency_contact: unknown;
    }>(
      sql`
    select phone, email, emergency_contact as "emergency_contact"
      from parties where org_id = ${orgId} and id = ${partyId}
  `,
      "objects",
    )
  )[0];
  if (!before) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the person behind this employment has no party record — withdraw this request; a proposal about a deleted party never applies",
    );
  }
  const beforeAddress = await loadMyAddress(exec, orgId, partyId);
  const normContact = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
    const record = value as Record<string, unknown>;
    return JSON.stringify({
      name: typeof record.name === "string" ? record.name : null,
      relationship: typeof record.relationship === "string" ? record.relationship : null,
      phone: typeof record.phone === "string" ? record.phone : null,
    });
  };
  const nextContact =
    payload.emergencyContact === undefined
      ? undefined
      : payload.emergencyContact === null
        ? null
        : {
            name: payload.emergencyContact.name,
            relationship: payload.emergencyContact.relationship,
            phone: payload.emergencyContact.phone,
          };
  const contactChanged =
    nextContact !== undefined && normContact(before.emergency_contact) !== normContact(nextContact);
  const phoneChanged =
    payload.phone !== undefined && (before.phone ?? null) !== (payload.phone ?? null);
  const emailChanged =
    payload.email !== undefined && (before.email ?? null) !== (payload.email ?? null);
  const addressChanged =
    payload.address !== undefined &&
    (beforeAddress === null ||
      (beforeAddress.line1 ?? null) !== (payload.address.line1 ?? null) ||
      (beforeAddress.line2 ?? null) !== (payload.address.line2 ?? null) ||
      (beforeAddress.city ?? null) !== (payload.address.city ?? null) ||
      (beforeAddress.region ?? null) !== (payload.address.region ?? null) ||
      (beforeAddress.postalCode ?? null) !== (payload.address.postalCode ?? null) ||
      (beforeAddress.country ?? null) !== (payload.address.country ?? null));
  if (!phoneChanged && !emailChanged && !contactChanged && !addressChanged) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — the contact record already carries these values; withdraw the request",
    );
  }
  if (phoneChanged || emailChanged || contactChanged) {
    // Null crosses as SQL NULL through the parameter (a JSON null would
    // store the JSON value null instead of clearing): the contact column
    // is set from a JSON string only when the proposal carries an object.
    const nextPhone = payload.phone === undefined ? before.phone : payload.phone;
    const nextEmail = payload.email === undefined ? before.email : payload.email;
    const contactFragment =
      nextContact === undefined
        ? sql`emergency_contact`
        : nextContact === null
          ? sql`null`
          : sql`${JSON.stringify(nextContact)}::jsonb`;
    const updated = await exec.execute(
      sql`
      update parties
         set phone = ${nextPhone},
             email = ${nextEmail},
             emergency_contact = ${contactFragment},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${partyId}
      returning id
    `,
      "objects",
    );
    if (updated.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the contact record changed while the approval was applying — retry the decision",
      );
    }
  }
  if (addressChanged && payload.address !== undefined) {
    if (beforeAddress === null) {
      const inserted = await exec.execute(
        sql`
        insert into addresses
          (org_id, party_id, line1, line2, city, region, postal_code, country,
           is_default_billing, created_by, updated_by)
        values (${orgId}, ${partyId}, ${payload.address.line1}, ${payload.address.line2},
                ${payload.address.city}, ${payload.address.region},
                ${payload.address.postalCode}, ${payload.address.country},
                true, ${actorId}, ${actorId})
        returning id
      `,
        "objects",
      );
      if (inserted.length !== 1) {
        throw new HrmChangeRequestError(
          "REFUSED",
          "the address was not stored — no row was written; retry the decision",
        );
      }
    } else {
      const updated = await exec.execute(
        sql`
        update addresses
           set line1 = ${payload.address.line1}, line2 = ${payload.address.line2},
               city = ${payload.address.city}, region = ${payload.address.region},
               postal_code = ${payload.address.postalCode}, country = ${payload.address.country},
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${beforeAddress.id}
        returning id
      `,
        "objects",
      );
      if (updated.length !== 1) {
        throw new HrmChangeRequestError(
          "REFUSED",
          "the address changed while the approval was applying — retry the decision",
        );
      }
    }
  }
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: "profile_changed",
    priorSnapshot: {
      party: {
        phone: before.phone,
        email: before.email,
        emergencyContact: before.emergency_contact,
      },
      address: beforeAddress,
    },
    closedVersions: [],
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: newRevision,
  });
}

/**
 * (g) Bank change: the worker's own direct-deposit proposal lands as a
 * new approved party_bank_accounts row — never an edit of an approved
 * row (a material edit re-enters approval natively, and this decision IS
 * the approval). The edited party is the bound employment's worker party
 * re-resolved under the aggregate lock, never a caller-supplied id; the
 * account number travels sealed and only the last four ever render, in
 * storage, audit, and notifications alike. Live prior rows retire onto
 * this event with the request reason; rows backing in-flight payment
 * instructions refuse first, naming the remedy. Evidenced as a
 * 'bank_details_changed' employment_changes event plus the bank row's
 * own audit entry, then the applied link and the revision bump — all in
 * the one approval transaction.
 */
async function applyBankChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: BankChangePayload;
    newRevision: number;
    recordedAt: DbInstant;
    recordedAtIso: string;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAtIso } = args;
  const aggregate = (
    await exec.execute<{ revision: number; worker_party_id: string }>(
      sql`
    select revision, worker_party_id from worker_employments
     where org_id = ${orgId} and id = ${request.employment_id} for update
  `,
      "objects",
    )
  )[0];
  if (!aggregate) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the employment is gone — withdraw this request; a proposal about a deleted aggregate never applies",
    );
  }
  const partyId = aggregate.worker_party_id;
  // Live prior rows retire onto this event; rows behind in-flight payment
  // instructions refuse first — approved money keeps paying exactly what
  // its file generation locked.
  const priors = await exec.execute<{
    id: string;
    bank_name: string | null;
    lastFour: string | null;
  }>(
    sql`
    select id, bank_name, account_last_four as "lastFour"
      from party_bank_accounts
     where org_id = ${orgId} and party_id = ${partyId}
       and is_active and retired_at is null
     order by created_at, id
  `,
    "objects",
  );
  if (priors.length > 0) {
    const inFlight =
      (
        await exec.execute<{ n: number }>(
          sql`
      select count(*)::int as n from payment_instructions instruction
       where instruction.org_id = ${orgId}
         and instruction.payee_bank_account_id in (${sql.join(
           priors.map((row) => sql`${row.id}::uuid`),
           sql`, `,
         )})
         and instruction.status in ('pending', 'approved', 'generated', 'sent')
    `,
          "objects",
        )
      )[0]?.n ?? 0;
    if (inFlight > 0) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "cancel in-flight payment instructions referencing these bank details before changing them — approved money keeps paying exactly what it was approved against",
      );
    }
  }
  const inserted = (
    await exec.execute<{ id: string }>(
      sql`
    insert into party_bank_accounts
      (org_id, party_id, source_change_request_id, bank_name, country, currency, routing,
       account_number_encrypted, account_last_four,
       approval_status, is_active, approved_at, approved_by,
       submitted_by, submitted_at, created_by, updated_by)
    values (${orgId}, ${partyId}, ${request.id}, ${payload.bankName}, ${payload.country ?? null},
            ${payload.currency ?? null}, ${JSON.stringify(payload.routing ?? {})}::jsonb,
            ${payload.sealedAccount}, ${payload.accountLastFour},
            'approved', true, ${recordedAtIso.slice(0, 10)}::date, ${actorId},
            ${request.submitted_by}, ${request.submitted_at},
            ${actorId}, ${actorId})
    returning id
  `,
      "objects",
    )
  )[0];
  if (!inserted) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the bank details were not stored — no row was written; retry the decision",
    );
  }
  const retired: Array<{ rowId: string; bankName: string | null; lastFour: string | null }> = [];
  for (const prior of priors) {
    const done = await exec.execute(
      sql`
      update party_bank_accounts
         set is_active = false, retired_at = now(), retired_by = ${actorId},
             retirement_reason = ${request.reason ?? ""},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${prior.id} and party_id = ${partyId}
         and is_active and retired_at is null
      returning id
    `,
      "objects",
    );
    if (done.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the prior bank details changed while the approval was applying — retry the decision",
      );
    }
    retired.push({ rowId: prior.id, bankName: prior.bank_name, lastFour: prior.lastFour });
  }
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: "bank_details_changed",
    priorSnapshot: {
      bank: {
        bankName: payload.bankName,
        country: payload.country ?? null,
        currency: payload.currency ?? null,
        lastFour: payload.accountLastFour,
      },
      retired,
    },
    closedVersions: [],
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  const audited = await exec.execute(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'party_bank_accounts', ${inserted.id}, 'insert',
            ${JSON.stringify({
              before: null,
              after: {
                bankName: payload.bankName,
                country: payload.country ?? null,
                currency: payload.currency ?? null,
                lastFour: payload.accountLastFour,
                approvalStatus: "approved",
              },
              reason: request.reason ?? "",
              employmentChangeId: changeId,
              requestId: request.id,
            })}::jsonb, ${actorId})
    returning id
  `,
    "objects",
  );
  if (audited.length !== 1) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the bank change could not be audited — nothing was stored; retry the decision",
    );
  }
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: newRevision,
  });
}

/**
 * (a) Hire: the first effective version on a version-less (reserved)
 * identity, evidenced as a non-closure 'created' event. A carried initial
 * assignment issues its slot in the same approval as the second aggregate
 * revision (its own 'assignment_issued' event), so one decision covers the
 * whole first-employment package — the request stamps the final revision
 * once, never twice.
 */
