import {
  and,
  asc,
  eq,
  gte,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import {
  projects,
  resRetainerDrawdownEntries,
  resRetainerDrawdowns,
  resRetainers,
  timeEntries,
} from "@openbooks/schema";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, lockProjectForScope } from "../organization/subsidiary-scope.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import {
  add,
  allocateLargestRemainder,
  cmp,
  mulDecimal,
  neg,
  roundMoney,
  sum,
} from "../money/money.ts";
import { parseIsoDate } from "../platform/business-date.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { ResourcingRefusal } from "./errors.ts";
import { weekDates } from "./weeks.ts";

type RetainerRow = typeof resRetainers.$inferSelect;
type RetainerWriteRow = RetainerRow & Record<string, unknown>;
type RetainerAuditRow = { id: string } & Record<string, unknown>;
type RetainerAuditLogWriteRow = { row_id: string } & Record<string, unknown>;
type DrawdownRow = typeof resRetainerDrawdowns.$inferSelect;
type RetainerState = RetainerRow["state"];
type RetainerCurrencyContext = { baseCurrency: string | null; customerCurrency: string | null };
type CurrencyRegistryRow = { code: string };

export type RetainerBalance = { amount: string; currency: string };

export interface RetainerPriceEntry {
  id: string;
  workedOn: string;
  hours: string;
}

export interface PricedRetainerEntry extends RetainerPriceEntry {
  amount: string;
}

export interface HoursDrawdownPrice {
  byEntry: PricedRetainerEntry[];
  byMonth: Record<string, string>;
  total: string;
  hours: string;
}

export interface CreateRetainerInput {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  projectId: string;
  customerPartyId: string;
  kind: "hours" | "fees";
  currency?: string;
  totalAmount?: unknown;
  totalHours?: unknown;
  unitRate?: unknown;
  startsOn: string;
  endsOn: string;
  retainerItemId: string;
  custom?: Record<string, unknown>;
}

type RetainerCreateIdempotency = {
  id: string;
  requestId: string;
  match: Record<string, unknown>;
};

export interface RetainerWriteInput {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  retainerId: string;
}

export interface DraftHoursDrawdownInput extends RetainerWriteInput {
  sunday: string;
}

export interface DraftFeeDrawdownInput extends RetainerWriteInput {
  sunday: string;
  rawAmount: unknown;
}

export interface DraftDrawdownResult {
  id: string;
  retainerId: string;
  weekStart: string;
  hours: string;
  amount: string;
  currency: string;
  byEntry: PricedRetainerEntry[];
  byMonth: Record<string, string>;
}

const OVERDRAW_REMEDIES = {
  hours: "bill the excess hours as time and materials",
  fees: "reduce the milestone drawdown to the remaining balance",
} as const;

/** Price approved time exactly, then allocate the rounded cents without losing a cent. */
export function priceHoursDrawdown(
  entries: readonly RetainerPriceEntry[],
  unitRate: string,
): HoursDrawdownPrice {
  const rate = requireDecimal(unitRate, "unitRate", "a rate per hour", "invalid_unit_rate");
  const seenIds = new Set<string>();
  const exactAmounts: string[] = [];
  const normalizedEntries = entries.map((entry) => {
    if (seenIds.has(entry.id)) throw new Error("retainer drawdown entries must have unique ids");
    seenIds.add(entry.id);
    const hours = requireDecimal(entry.hours, "hours", "a number of hours", "invalid_hours");
    if (cmp(hours, "0") <= 0) {
      throw new ResourcingRefusal(
        422,
        "invalid_hours",
        `time entry ${entry.id} must have positive hours`,
        "use an approved time entry with positive hours",
        "hours",
      );
    }
    requireIsoDate(entry.workedOn, "workedOn");
    const normalizedHours = roundMoney(hours, 4);
    exactAmounts.push(mulDecimal(normalizedHours, rate));
    return { ...entry, hours: normalizedHours };
  });

  const allocated = allocateLargestRemainder(exactAmounts, 2);
  const byEntry = normalizedEntries.map((entry, index) => ({
    ...entry,
    amount: allocated[index]!,
  }));
  const monthTotals = new Map<string, string>();
  for (const entry of byEntry) {
    const month = entry.workedOn.slice(0, 7);
    monthTotals.set(month, add(monthTotals.get(month) ?? "0", entry.amount));
  }
  const byMonth = Object.fromEntries([...monthTotals].sort(([left], [right]) => left.localeCompare(right)));
  return {
    byEntry,
    byMonth,
    total: sum(byEntry.map((entry) => entry.amount)),
    hours: sum(byEntry.map((entry) => entry.hours)),
  };
}

/** The remaining contract liability, derived only from posted drawdowns. */
export function balanceOf(
  retainer: Pick<RetainerRow, "totalAmount" | "currency">,
  postedDrawdowns: readonly Pick<DrawdownRow, "amount">[],
): RetainerBalance {
  return {
    amount: add(retainer.totalAmount, neg(sum(postedDrawdowns.map((drawdown) => drawdown.amount)))),
    currency: retainer.currency,
  };
}

/** Resolve the next persisted lifecycle state from current posted evidence and the org's business day. */
export function nextRetainerState(
  retainer: Pick<RetainerRow, "state" | "endsOn">,
  balance: string,
  today: string,
): RetainerState {
  if (cmp(balance, "0") < 0) throw new Error("retainer balance cannot be negative");
  requireIsoDate(retainer.endsOn, "endsOn");
  requireIsoDate(today, "today");
  if (retainer.state !== "active") return retainer.state;
  if (cmp(balance, "0") === 0) return "exhausted";
  if (today > retainer.endsOn) return "expired";
  return "active";
}

/** Refuse a drawdown that exceeds this retainer kind's remaining balance. */
export function assertDrawdownWithinBalance(
  amount: string,
  balance: string,
  kind: "hours" | "fees",
): void {
  if (cmp(amount, balance) <= 0) return;
  throw new ResourcingRefusal(
    409,
    "retainer_overdraw",
    `drawdown amount ${roundMoney(amount, 2)} exceeds the remaining retainer balance ${roundMoney(balance, 2)}`,
    OVERDRAW_REMEDIES[kind],
    "amount",
  );
}

/** Refuse to close a retainer whose posted drawdowns leave a balance. */
export function assertRetainerCanClose(balance: string): void {
  if (cmp(balance, "0") < 0) throw new Error("retainer balance cannot be negative");
  if (cmp(balance, "0") === 0) return;
  throw new ResourcingRefusal(
    409,
    "retainer_balance_remaining",
    `retainer still has a balance of ${roundMoney(balance, 2)}`,
    "draw down the remaining balance or extend the retainer",
    "retainerId",
  );
}

/** Every service write supplies a RETURNING result and must change the exact expected number of rows. */
export function assertWriteRows(rows: readonly unknown[], expected: number, operation: string): void {
  if (rows.length !== expected) {
    throw new Error(`${operation} wrote ${rows.length} rows; expected exactly ${expected}`);
  }
}

export async function createRetainer(
  input: CreateRetainerInput,
  idempotency?: RetainerCreateIdempotency,
): Promise<RetainerRow> {
  const startsOn = requireIsoDate(input.startsOn, "startsOn");
  const endsOn = requireIsoDate(input.endsOn, "endsOn");
  if (startsOn > endsOn) {
    throw new ResourcingRefusal(
      422,
      "retainer_date_order",
      "retainer end date is before its start date",
      "enter an end date on or after the start date",
      "endsOn",
    );
  }

  let totalAmount: string;
  let totalHours: string | null = null;
  let unitRate: string | null = null;
  if (input.kind === "hours") {
    totalHours = requireDecimal(input.totalHours, "totalHours", "a number of hours", "invalid_hours");
    unitRate = requireDecimal(input.unitRate, "unitRate", "a rate per hour", "invalid_unit_rate");
    if (cmp(totalHours, "0") <= 0) {
      throw new ResourcingRefusal(422, "invalid_hours", "retainer hours must be positive", "enter a positive number of hours", "totalHours");
    }
    if (cmp(unitRate, "0") <= 0) {
      throw new ResourcingRefusal(422, "invalid_unit_rate", "retainer unit rate must be positive", "enter a positive rate per hour", "unitRate");
    }
    totalAmount = roundMoney(mulDecimal(roundMoney(totalHours, 4), roundMoney(unitRate, 4)), 2);
  } else {
    if (input.totalHours != null || input.unitRate != null) {
      throw new ResourcingRefusal(
        422,
        "fees_retainer_has_hour_terms",
        "a fees retainer cannot carry hour terms",
        "omit total hours and unit rate for a fees retainer",
        "kind",
      );
    }
    const rawAmount = requireDecimal(input.totalAmount, "totalAmount", "an amount", "invalid_amount");
    totalAmount = roundMoney(rawAmount, 2);
  }
  if (cmp(totalAmount, "0") <= 0) {
    throw new ResourcingRefusal(
      422,
      "retainer_amount_too_small",
      "retainer total amount must be at least one cent",
      "increase the retainer terms so the total rounds to at least one cent",
      "totalAmount",
    );
  }

  return withRetainerWrite(input.orgId, async (tx) => {
    await lockProjectForScope(tx, input.orgId, input.projectId, input.allowedSubsidiaryIds);
    const [project] = await tx.select({
      customerId: projects.customerId,
      status: projects.status,
    }).from(projects).where(and(eq(projects.orgId, input.orgId), eq(projects.id, input.projectId))).limit(1);
    if (!project) throw new ScopeNotFoundError();
    if (project.status === "closed" || project.status === "cancelled") {
      throw new ResourcingRefusal(
        409,
        "project_not_open",
        `cannot create a retainer for a ${project.status} project`,
        "reopen the project or choose an active one",
        "projectId",
      );
    }
    if (project.customerId !== input.customerPartyId) {
      throw new ResourcingRefusal(
        422,
        "retainer_customer_mismatch",
        "retainer customer does not match the project's customer",
        "select the customer assigned to this project",
        "customerPartyId",
      );
    }
    const currency = await resolveRetainerCurrency(tx, input);

    let retainer: RetainerRow;
    if (idempotency) {
      const result = await tx.execute<RetainerWriteRow>(sql`
        insert into res_retainers (
          id, org_id, project_id, customer_party_id, kind, total_amount, currency, total_hours,
          unit_rate, starts_on, ends_on, retainer_item_id, custom, created_by, updated_by
        ) values (
          coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${input.orgId},
          ${input.projectId}, ${input.customerPartyId}, ${input.kind}, ${totalAmount}, ${currency},
          ${totalHours}, ${unitRate}, ${startsOn}, ${endsOn}, ${input.retainerItemId},
          ${JSON.stringify(input.custom ?? {})}::jsonb, ${input.actorId}, ${input.actorId}
        ) returning id, org_id as "orgId", project_id as "projectId",
          customer_party_id as "customerPartyId", kind, total_amount::text as "totalAmount",
          currency,
          total_hours::text as "totalHours", unit_rate::text as "unitRate",
          starts_on::text as "startsOn", ends_on::text as "endsOn",
          retainer_item_id as "retainerItemId", invoice_document_id as "invoiceDocumentId",
          obligation_id as "obligationId", state, custom, created_at as "createdAt",
          created_by as "createdBy", updated_at as "updatedAt", updated_by as "updatedBy"
      `);
      assertWriteRows(result.rows, 1, "retainer creation");
      retainer = result.rows[0] as RetainerRow;
      await writeIdempotentCreateAudit(tx, {
        orgId: input.orgId,
        rowId: retainer.id,
        after: retainer,
        actorId: input.actorId,
        requestId: idempotency.requestId,
        match: idempotency.match,
      });
    } else {
      const inserted = await tx.insert(resRetainers).values({
        orgId: input.orgId,
        projectId: input.projectId,
        customerPartyId: input.customerPartyId,
        kind: input.kind,
        totalAmount,
        currency,
        totalHours,
        unitRate,
        startsOn,
        endsOn,
        retainerItemId: input.retainerItemId,
        custom: input.custom ?? {},
        createdBy: input.actorId,
        updatedBy: input.actorId,
      }).returning();
      assertWriteRows(inserted, 1, "retainer creation");
      retainer = inserted[0]!;
      await writeAudit(input.orgId, "res_retainers", retainer.id, "insert", {
        after: {
          projectId: input.projectId,
          customerPartyId: input.customerPartyId,
          kind: input.kind,
          totalAmount,
          currency,
          totalHours,
          unitRate,
          startsOn,
          endsOn,
          retainerItemId: input.retainerItemId,
          state: "draft",
        },
      }, input.actorId);
    }
    return retainer;
  });
}

export async function draftHoursDrawdown(input: DraftHoursDrawdownInput): Promise<DraftDrawdownResult> {
  const dates = requireSunday(input.sunday);
  return withRetainerWrite(input.orgId, async () => {
    const retainer = await loadRetainerForUpdate(input);
    requireActiveRetainer(retainer);
    if (retainer.kind !== "hours") {
      throw new ResourcingRefusal(
        422,
        "retainer_kind_mismatch",
        "time entries can only be drawn against an hours retainer",
        "choose an hours retainer for approved time",
        "retainerId",
      );
    }
    await refuseExistingDrawdown(input.orgId, input.retainerId, input.sunday);

    const firstDate = dates[0]! > retainer.startsOn ? dates[0]! : retainer.startsOn;
    const lastDate = dates[6]! < retainer.endsOn ? dates[6]! : retainer.endsOn;
    const heldEntries = db.select({ id: resRetainerDrawdownEntries.id })
      .from(resRetainerDrawdownEntries)
      .where(and(
        eq(resRetainerDrawdownEntries.orgId, input.orgId),
        eq(resRetainerDrawdownEntries.timeEntryId, timeEntries.id),
      ));
    const entries = firstDate > lastDate
      ? []
      : await db.select({
        id: timeEntries.id,
        workedOn: timeEntries.workedOn,
        hours: timeEntries.hours,
      }).from(timeEntries).where(and(
        eq(timeEntries.orgId, input.orgId),
        eq(timeEntries.projectId, retainer.projectId),
        eq(timeEntries.status, "approved"),
        eq(timeEntries.isBillable, true),
        gte(timeEntries.workedOn, firstDate),
        lte(timeEntries.workedOn, lastDate),
        notExists(heldEntries),
      )).orderBy(asc(timeEntries.workedOn), asc(timeEntries.id)).for("update");
    if (entries.length === 0) {
      throw new ResourcingRefusal(
        422,
        "no_eligible_time_entries",
        "no approved, billable, undrawn time entries fall in this retainer week",
        "choose a Sunday week with approved billable time inside the retainer dates that has not been drawn down",
        "sunday",
      );
    }
    if (retainer.unitRate === null || retainer.totalHours === null) {
      throw new Error("hours retainer is missing its required hour terms");
    }
    const priced = priceHoursDrawdown(entries, retainer.unitRate);
    const balance = await retainerBalance(input.orgId, retainer);
    assertDrawdownWithinBalance(priced.total, balance.amount, "hours");

    const inserted = await db.insert(resRetainerDrawdowns).values({
      orgId: input.orgId,
      retainerId: input.retainerId,
      weekStart: input.sunday,
      hours: priced.hours,
      amount: priced.total,
      state: "draft",
      createdBy: input.actorId,
      updatedBy: input.actorId,
    }).returning();
    assertWriteRows(inserted, 1, "hours drawdown creation");
    const drawdown = inserted[0]!;
    const linkRows = await db.insert(resRetainerDrawdownEntries).values(priced.byEntry.map((entry) => ({
      orgId: input.orgId,
      drawdownId: drawdown.id,
      timeEntryId: entry.id,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    }))).returning({ id: resRetainerDrawdownEntries.id });
    assertWriteRows(linkRows, priced.byEntry.length, "hours drawdown evidence links");
    await writeAudit(input.orgId, "res_retainer_drawdowns", drawdown.id, "insert", {
      after: {
        retainerId: input.retainerId,
        weekStart: input.sunday,
        hours: priced.hours,
        amount: priced.total,
        state: "draft",
        timeEntryIds: priced.byEntry.map((entry) => entry.id),
      },
    }, input.actorId);
    return {
      id: drawdown.id,
      retainerId: input.retainerId,
      weekStart: input.sunday,
      hours: priced.hours,
      amount: priced.total,
      currency: retainer.currency,
      byEntry: priced.byEntry,
      byMonth: priced.byMonth,
    };
  });
}

export async function draftFeeDrawdown(input: DraftFeeDrawdownInput): Promise<DraftDrawdownResult> {
  requireSunday(input.sunday);
  const rawAmount = requireDecimal(input.rawAmount, "amount", "an amount", "invalid_amount");
  const amount = roundMoney(rawAmount, 2);
  if (cmp(amount, "0") <= 0) {
    throw new ResourcingRefusal(422, "invalid_amount", "drawdown amount must be positive", "enter a positive amount", "amount");
  }

  return withRetainerWrite(input.orgId, async () => {
    const retainer = await loadRetainerForUpdate(input);
    requireActiveRetainer(retainer);
    if (retainer.kind !== "fees") {
      throw new ResourcingRefusal(
        422,
        "retainer_kind_mismatch",
        "a milestone amount can only be drawn against a fees retainer",
        "choose a fees retainer for a milestone drawdown",
        "retainerId",
      );
    }
    await refuseExistingDrawdown(input.orgId, input.retainerId, input.sunday);
    const balance = await retainerBalance(input.orgId, retainer);
    assertDrawdownWithinBalance(amount, balance.amount, "fees");
    const inserted = await db.insert(resRetainerDrawdowns).values({
      orgId: input.orgId,
      retainerId: input.retainerId,
      weekStart: input.sunday,
      hours: "0.0000",
      amount,
      state: "draft",
      createdBy: input.actorId,
      updatedBy: input.actorId,
    }).returning();
    assertWriteRows(inserted, 1, "fee drawdown creation");
    const drawdown = inserted[0]!;
    await writeAudit(input.orgId, "res_retainer_drawdowns", drawdown.id, "insert", {
      after: {
        retainerId: input.retainerId,
        weekStart: input.sunday,
        hours: "0.0000",
        amount,
        state: "draft",
      },
    }, input.actorId);
    return {
      id: drawdown.id,
      retainerId: input.retainerId,
      weekStart: input.sunday,
      hours: "0.0000",
      amount,
      currency: retainer.currency,
      byEntry: [],
      byMonth: {},
    };
  });
}

export async function extendRetainer(
  input: RetainerWriteInput & { newEndsOn: string },
): Promise<{ id: string; state: "active"; endsOn: string }> {
  const newEndsOn = requireIsoDate(input.newEndsOn, "newEndsOn");
  return withRetainerWrite(input.orgId, async () => {
    const retainer = await loadRetainerForUpdate(input);
    if (retainer.state !== "expired" && retainer.state !== "active") {
      throw new ResourcingRefusal(
        409,
        "retainer_not_extendable",
        `a ${retainer.state} retainer cannot be extended`,
        "choose an active or expired retainer",
        "retainerId",
      );
    }
    if (newEndsOn <= retainer.endsOn) {
      throw new ResourcingRefusal(
        422,
        "retainer_extension_not_later",
        "retainer extension must move the end date later",
        "enter an end date later than the current end date",
        "newEndsOn",
      );
    }
    const updated = await db.update(resRetainers).set({
      endsOn: newEndsOn,
      state: "active",
      updatedAt: new Date(),
      updatedBy: input.actorId,
    }).where(and(
      eq(resRetainers.orgId, input.orgId),
      eq(resRetainers.id, input.retainerId),
      eq(resRetainers.state, retainer.state),
      eq(resRetainers.endsOn, retainer.endsOn),
    )).returning({ id: resRetainers.id });
    assertWriteRows(updated, 1, "retainer extension");
    await writeAudit(input.orgId, "res_retainers", input.retainerId, "update", {
      before: { endsOn: retainer.endsOn, state: retainer.state },
      after: { endsOn: newEndsOn, state: "active" },
    }, input.actorId);
    return { id: input.retainerId, state: "active", endsOn: newEndsOn };
  });
}

export async function closeRetainer(
  input: RetainerWriteInput,
): Promise<{ id: string; state: "closed" }> {
  return withRetainerWrite(input.orgId, async () => {
    const retainer = await loadRetainerForUpdate(input);
    const balance = await retainerBalance(input.orgId, retainer);
    assertRetainerCanClose(balance.amount);
    if (retainer.state === "closed") {
      throw new ResourcingRefusal(409, "retainer_already_closed", "retainer is already closed", "choose a retainer that is not closed", "retainerId");
    }
    const updated = await db.update(resRetainers).set({
      state: "closed",
      updatedAt: new Date(),
      updatedBy: input.actorId,
    }).where(and(
      eq(resRetainers.orgId, input.orgId),
      eq(resRetainers.id, input.retainerId),
      eq(resRetainers.state, retainer.state),
    )).returning({ id: resRetainers.id });
    assertWriteRows(updated, 1, "retainer close");
    await writeAudit(input.orgId, "res_retainers", input.retainerId, "update", {
      before: { state: retainer.state, balance },
      after: { state: "closed", balance },
    }, input.actorId);
    return { id: input.retainerId, state: "closed" };
  });
}

async function withRetainerWrite<T>(orgId: string, work: (tx: typeof db) => Promise<T>): Promise<T> {
  try {
    return await withOrgTransaction(orgId, async () => {
      const tx = db;
      await acquireOrgFeatureGateLock(tx, orgId);
      if (!(await lockAndCheckOrgFeature(tx, orgId, "retainerBilling"))) {
        throw new ResourcingRefusal(
          409,
          "retainer_billing_disabled",
          "retainer billing is disabled for this organization",
          "enable Retainer Billing in Company Settings → Features",
        );
      }
      return work(tx);
    });
  } catch (error) {
    const constraint = postgresUniqueConstraint(error);
    if (constraint === "res_retainer_drawdowns_retainer_week") {
      throw new ResourcingRefusal(
        409,
        "drawdown_exists",
        "this retainer already has a drawdown for that Sunday week",
        "choose a different Sunday week with undrawn approved billable time",
        "sunday",
      );
    }
    if (constraint === "res_retainer_drawdown_entries_time_entry") {
      throw new ResourcingRefusal(
        409,
        "time_entry_already_drawn",
        "one or more time entries were drawn down by another request",
        "draft a drawdown using approved billable time that has not already been drawn down",
        "retainerId",
      );
    }
    throw error;
  }
}

async function writeIdempotentCreateAudit(
  tx: SqlExecutor,
  input: { orgId: string; rowId: string; after: object; actorId: string; requestId: string; match: Record<string, unknown> },
): Promise<void> {
  const result = await tx.execute<RetainerAuditRow>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${input.orgId}, 'res_retainers', ${input.rowId}, 'insert',
      ${JSON.stringify({ before: null, after: input.after, match: input.match })}::jsonb,
      ${input.actorId}, ${input.requestId})
    returning id
  `);
  if ((result.rowCount ?? 0) !== 1 || result.rows.length !== 1) {
    throw new Error(`audit record for retainer ${input.rowId} wrote ${result.rows.length} rows; expected exactly one`);
  }
}

async function loadRetainerForUpdate(input: RetainerWriteInput): Promise<RetainerRow> {
  const [candidate] = await db.select({ projectId: resRetainers.projectId })
    .from(resRetainers)
    .where(and(eq(resRetainers.orgId, input.orgId), eq(resRetainers.id, input.retainerId)))
    .limit(1);
  if (!candidate) throw new ScopeNotFoundError();
  await lockProjectForScope(db, input.orgId, candidate.projectId, input.allowedSubsidiaryIds);
  const [retainer] = await db.select().from(resRetainers)
    .where(and(eq(resRetainers.orgId, input.orgId), eq(resRetainers.id, input.retainerId)))
    .limit(1)
    .for("update");
  if (!retainer) throw new ScopeNotFoundError();
  return retainer;
}

async function resolveRetainerCurrency(
  tx: typeof db,
  input: CreateRetainerInput,
): Promise<string> {
  const context = (await tx.execute<RetainerCurrencyContext>(sql`
    select o.base_currency as "baseCurrency", cr.currency as "customerCurrency"
      from orgs o
      left join customer_roles cr
        on cr.org_id = o.id and cr.party_id = ${input.customerPartyId}
     where o.id = ${input.orgId}
  `)).rows[0];
  const baseCurrency = context?.baseCurrency?.trim().toUpperCase();
  if (!baseCurrency) throw new Error(`organization ${input.orgId} has no base currency`);
  const customerCurrency = context?.customerCurrency?.trim();
  const currency = (input.currency ?? (customerCurrency || baseCurrency)).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ResourcingRefusal(
      422,
      "invalid_currency",
      "retainer currency must be a three-letter currency code",
      "choose a currency listed under Company Settings → Setup → Currencies",
      "currency",
    );
  }
  const registered = await tx.execute<CurrencyRegistryRow>(sql`
    select code from currencies where code = ${currency}
  `);
  if (!registered.rows[0]) {
    throw new ResourcingRefusal(
      422,
      "currency_not_enabled",
      `currency ${currency} is not available in the currency registry`,
      "choose a currency listed under Company Settings → Setup → Currencies",
      "currency",
    );
  }
  if (!(await lockAndCheckOrgFeature(tx, input.orgId, "multiCurrency")) && currency !== baseCurrency) {
    throw new ResourcingRefusal(
      422,
      "multi_currency_disabled",
      `retainer currency ${currency} differs from the organization's base currency ${baseCurrency}`,
      "turn on Multi-Currency in Company Settings → Features or choose the organization's base currency",
      "currency",
    );
  }
  return currency;
}

async function retainerBalance(orgId: string, retainer: RetainerRow): Promise<RetainerBalance> {
  const posted = await db.select({ amount: resRetainerDrawdowns.amount })
    .from(resRetainerDrawdowns)
    .where(and(
      eq(resRetainerDrawdowns.orgId, orgId),
      eq(resRetainerDrawdowns.retainerId, retainer.id),
      eq(resRetainerDrawdowns.state, "posted"),
    ));
  return balanceOf(retainer, posted);
}

async function refuseExistingDrawdown(orgId: string, retainerId: string, sunday: string): Promise<void> {
  const existing = await db.select({ id: resRetainerDrawdowns.id })
    .from(resRetainerDrawdowns)
    .where(and(
      eq(resRetainerDrawdowns.orgId, orgId),
      eq(resRetainerDrawdowns.retainerId, retainerId),
      eq(resRetainerDrawdowns.weekStart, sunday),
    ))
    .limit(1);
  if (existing.length > 0) {
    throw new ResourcingRefusal(
      409,
      "drawdown_exists",
      "this retainer already has a drawdown for that Sunday week",
      "choose a different Sunday week with undrawn approved billable time",
      "sunday",
    );
  }
}

async function writeAudit(
  orgId: string,
  tableName: string,
  rowId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  const rows = await db.execute<RetainerAuditLogWriteRow>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${tableName}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning row_id
  `);
  assertWriteRows(rows.rows, 1, `audit record for ${tableName}`);
}

function requireActiveRetainer(retainer: RetainerRow): void {
  if (retainer.state === "active") return;
  const remedy = retainer.state === "expired"
    ? "extend the retainer with a later end date"
    : "choose an active retainer";
  throw new ResourcingRefusal(
    409,
    "retainer_not_active",
    `a ${retainer.state} retainer cannot be drawn down`,
    remedy,
    "retainerId",
  );
}

function requireDecimal(raw: unknown, field: string, noun: string, code: string): string {
  const exact = canonicalDecimal(raw, 4);
  if (exact !== null) return exact;
  throw new ResourcingRefusal(
    422,
    code,
    `${field} cannot be read as ${noun}`,
    decimalNullRefusal(field, noun, raw, 4),
    field,
  );
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value === "string") {
    try {
      parseIsoDate(value);
      return value;
    } catch {
      // The refusal below gives callers the same remedy for malformed and impossible dates.
    }
  }
  throw new ResourcingRefusal(
    422,
    "invalid_retainer_date",
    `${field} must be a real calendar date`,
    "enter a valid date in YYYY-MM-DD format",
    field,
  );
}

function requireSunday(sunday: string): string[] {
  try {
    return weekDates(sunday);
  } catch {
    throw new ResourcingRefusal(
      422,
      "invalid_drawdown_week",
      "drawdown week must start on a valid Sunday",
      "choose a Sunday date for the start of the drawdown week",
      "sunday",
    );
  }
}

function postgresUniqueConstraint(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && typeof candidate.constraint === "string") return candidate.constraint;
    current = candidate.cause;
  }
  return null;
}
