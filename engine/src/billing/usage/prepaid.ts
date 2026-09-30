import { refreshPrepaidBreakage,lockPrepaidRecognitionContract } from '../../revenue/prepaid-breakage.ts'
import { sql } from "drizzle-orm";
import { usagePrepaidDraws, type usagePrepaidGrants as UsagePrepaidGrantTable } from "@openbooks/schema";
import { cmp } from "../../money/money.ts";
import { negMoney, parseMoney, subMoney } from "../../money/brands.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows, subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { db, withOrg } from "../../platform/db.ts";
import { UsageBillingError } from "./errors.ts";

export type UsagePrepaidGrant = typeof UsagePrepaidGrantTable.$inferSelect;
export type UsagePrepaidState = "active" | "depleted" | "expired";
export type UsageSubsidiaryScope = ReadonlySet<string> | null;

export interface CreatePrepaidGrantInput {
  customerId: string;
  sourceDocumentLineId: string;
  amount: unknown;
  currency: string;
  expiresOn?: string | null;
}

export interface RecordPrepaidDrawInput {
  grantId: string;
  runId?: string | null;
  periodMonth: string;
  amount: unknown;
}

const FEATURE_REMEDY = "Enable Usage Billing in Company Settings → Features.";
const GRANT_COLUMNS = sql`
  id, org_id as "orgId", customer_id as "customerId",
  source_document_line_id as "sourceDocumentLineId", amount::text as amount,
  currency_code as currency, expires_on::text as "expiresOn",
  created_at as "createdAt", created_by as "createdBy"`;
const LIST_GRANT_COLUMNS = sql`
  g.id, g.org_id as "orgId", g.customer_id as "customerId",
  g.source_document_line_id as "sourceDocumentLineId", g.amount::text as amount,
  g.currency_code as currency, g.expires_on::text as "expiresOn",
  g.created_at as "createdAt", g.created_by as "createdBy"`;
const DRAW_COLUMNS = sql`
  id, org_id as "orgId", grant_id as "grantId", run_id as "runId",
  period_month::text as "periodMonth", amount::text as amount,
  reverses_draw_id as "reversesDrawId", created_at as "createdAt"`;

function refuse(
  code: string,
  message: string,
  remedy: string,
  field: string | null = null,
  status: 422 | 409 = 422,
): never {
  throw new UsageBillingError(code, message, remedy, { field, status });
}

function featureOff(): never {
  return refuse("feature_off", "Usage billing is turned off for this organization.", FEATURE_REMEDY);
}

async function lockAndRequireUsageBilling(orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(db, orgId);
  if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) featureOff();
}

async function requireUsageBillingRead(orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "usageBilling"))) featureOff();
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse("usage_prepaid_input_required", `${field} is required.`, `Provide a non-empty ${field}.`, field);
  }
  return value.trim();
}

function uuidText(value: unknown, field: string): string {
  const candidate = requiredText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    refuse("usage_prepaid_uuid_invalid", `${field} must be a UUID.`, `Provide a valid ${field} from this organization.`, field);
  }
  return candidate;
}

function dateText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    refuse("usage_prepaid_date_invalid", `${field} must be a real calendar date in YYYY-MM-DD form.`, `Provide a valid ${field} in YYYY-MM-DD form.`, field);
  }
  return value;
}

function exactMoney(value: unknown, field: string): string {
  let money: string;
  try {
    money = parseMoney(value);
  } catch {
    refuse("usage_prepaid_amount_invalid", `${field} must be an exact money amount with no more than 4 decimal places.`, `Provide ${field} as a decimal string with no more than 4 decimal places.`, field);
  }
  if (money.split(".", 1)[0]!.replace(/^0+/, "").length > 15) {
    refuse("usage_prepaid_amount_invalid", `${field} exceeds the supported numeric(19,4) range.`, `Provide ${field} with no more than 15 whole digits.`, field);
  }
  return money;
}

function uniqueViolationFor(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

export async function createPrepaidGrant(
  orgId: string,
  actor: string,
  input: CreatePrepaidGrantInput,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<UsagePrepaidGrant> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const customerId = uuidText(input.customerId, "customer_id");
    const customer = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId" from parties p where org_id = ${orgId} and id = ${customerId}
        ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
        for share`)).rows[0];
    if (!customer || !subsidiaryScopeAllows(allowedSubsidiaryIds, customer.subsidiaryId, { orgWideNull: true })) throw new ScopeNotFoundError();
    const sourceLineId = uuidText(input.sourceDocumentLineId, "source_document_line_id");
    const amount = exactMoney(input.amount, "amount");
    if (cmp(amount, "0") <= 0) {
      refuse("usage_prepaid_amount_invalid", "A prepaid grant amount must be greater than zero.", "Provide the positive amount billed for the prepaid usage item.", "amount");
    }
    const currency = requiredText(input.currency, "currency");
    if (!/^[A-Z]{3}$/.test(currency)) {
      refuse("usage_prepaid_currency_invalid", "The prepaid grant currency must be an uppercase ISO currency code.", "Use the currency recorded on the posted customer invoice.", "currency");
    }
    const expiresOn = input.expiresOn == null ? null : dateText(input.expiresOn, "expires_on");

    const source = (await db.execute<{
      customerId: string | null;
      invoiceCurrency: string;
      lineAmount: string;
    }>(sql`
      select d.party_id as "customerId", d.currency as "invoiceCurrency", dl.amount::text as "lineAmount"
        from document_lines dl
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
        join items i on i.org_id = dl.org_id and i.id = dl.item_id
        join recognition_rules r on r.org_id = i.org_id and r.id = i.recognition_rule_id
        join performance_obligations o
          on o.org_id = dl.org_id and o.document_line_id = dl.id and o.recognition_rule_id = r.id
       where dl.org_id = ${orgId} and dl.id = ${sourceLineId}
         and d.kind = 'customer_invoice' and d.status = 'posted' and r.method = 'usage'
       for update of d`)).rows[0];
    if (!source) {
      refuse(
        "usage_prepaid_source_not_eligible",
        "The source line is not on a posted customer invoice with a usage-method recognition rule on its item.",
        "Set a usage-method recognition rule on the prepaid item and bill it again.",
        "source_document_line_id",
      );
    }
    if (source.customerId !== customerId) {
      refuse("usage_prepaid_customer_mismatch", "The prepaid grant customer does not match the posted invoice customer.", "Create the grant for the customer named on the posted customer invoice.", "customer_id");
    }
    if (source.invoiceCurrency !== currency) {
      refuse("usage_prepaid_currency_mismatch", `The grant currency ${currency} does not match the posted invoice currency ${source.invoiceCurrency}.`, "Use the currency recorded on the posted customer invoice.", "currency");
    }
    const alreadyGranted = (await db.execute<{ amount: string }>(sql`
      select coalesce(sum(amount), 0)::text as amount
        from usage_prepaid_grants
       where org_id = ${orgId} and source_document_line_id = ${sourceLineId}`)).rows[0]?.amount ?? "0";
    const remainingLineAmount = subMoney(source.lineAmount, alreadyGranted);
    if (cmp(amount, remainingLineAmount) > 0) {
      refuse(
        "usage_prepaid_grant_exceeds_source",
        "The requested prepaid grant exceeds the unallocated amount on its posted invoice line.",
        `Limit the grant to the remaining posted line amount of ${remainingLineAmount}.`,
        "amount",
      );
    }
    const inserted = await db.execute<UsagePrepaidGrant>(sql`
      insert into usage_prepaid_grants
        (org_id, customer_id, source_document_line_id, amount, currency_code, expires_on, created_by)
      values (${orgId}, ${customerId}, ${sourceLineId}, ${amount}, ${currency}, ${expiresOn}, ${actor})
      returning ${GRANT_COLUMNS}`);
    if (inserted.rows.length !== 1) throw new Error("prepaid grant insert returned an unexpected row count");
    return inserted.rows[0]!;
  });
}

interface PrepaidSnapshot {
  amount: string;
  expiresOn: string | null;
  drawn: string;
}

async function readSnapshot(
  orgId: string,
  grantIdInput: string,
  asOfInput: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<PrepaidSnapshot> {
  const grantId = uuidText(grantIdInput, "grant_id");
  const asOf = dateText(asOfInput, "as_of");
  const grant = (await db.execute<{ amount: string; expiresOn: string | null; subsidiaryId: string | null }>(sql`
    select g.amount::text as amount, g.expires_on::text as "expiresOn", c.subsidiary_id as "subsidiaryId"
      from usage_prepaid_grants g join parties c on c.org_id = g.org_id and c.id = g.customer_id
     where g.org_id = ${orgId} and g.id = ${grantId}
       ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)).rows[0];
  if (!grant || !subsidiaryScopeAllows(allowedSubsidiaryIds, grant.subsidiaryId, { orgWideNull: true })) throw new ScopeNotFoundError();
  const drawn = (await db.execute<{ amount: string }>(sql`
    select coalesce(sum(amount), 0)::text as amount
      from usage_prepaid_draws
     where org_id = ${orgId} and grant_id = ${grantId} and period_month <= ${asOf}`)).rows[0]?.amount ?? "0";
  return { amount: grant.amount, expiresOn: grant.expiresOn, drawn };
}

export async function prepaidBalance(
  orgId: string,
  grantId: string,
  asOf: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<string> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const snapshot = await readSnapshot(orgId, grantId, asOf, allowedSubsidiaryIds);
    return subMoney(snapshot.amount, snapshot.drawn);
  });
}

export async function prepaidState(
  orgId: string,
  grantId: string,
  asOf: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<{ state: UsagePrepaidState; balance: string }> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const date = dateText(asOf, "as_of");
    const snapshot = await readSnapshot(orgId, grantId, date, allowedSubsidiaryIds);
    const balance = subMoney(snapshot.amount, snapshot.drawn);
    if (cmp(balance, "0") <= 0) return { state: "depleted", balance };
    if (snapshot.expiresOn !== null && date > snapshot.expiresOn) return { state: "expired", balance };
    return { state: "active", balance };
  });
}

export async function listPrepaidGrants(orgId: string, asOf: string, allowedSubsidiaryIds: UsageSubsidiaryScope = null): Promise<Array<UsagePrepaidGrant & {
  balance: string;
  state: UsagePrepaidState;
}>> {
  return withOrg(orgId, async () => {
    await requireUsageBillingRead(orgId);
    const date = dateText(asOf, "as_of");
    const rows = (await db.execute<UsagePrepaidGrant & { drawn: string; subsidiaryId: string | null }>(sql`
      select ${LIST_GRANT_COLUMNS}, c.subsidiary_id as "subsidiaryId",
             coalesce(sum(d.amount), 0)::text as drawn
        from usage_prepaid_grants g
        join parties c on c.org_id = g.org_id and c.id = g.customer_id
        left join usage_prepaid_draws d on d.org_id = g.org_id and d.grant_id = g.id and d.period_month <= ${date}::date
       where g.org_id = ${orgId}
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       group by g.id, c.subsidiary_id
       order by g.created_at, g.id`)).rows;
    return rows.map(({ drawn, subsidiaryId, ...grant }) => {
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId, { orgWideNull: true })) throw new ScopeNotFoundError();
      const balance = subMoney(grant.amount, drawn);
      const state: UsagePrepaidState = cmp(balance, "0") <= 0
        ? "depleted"
        : grant.expiresOn !== null && date > grant.expiresOn ? "expired" : "active";
      return { ...grant, balance, state };
    });
  });
}

/** Internal append-only draw writer used by the usage rating commit path. */
export async function recordPrepaidDraw(
  orgId: string,
  input: RecordPrepaidDrawInput,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<typeof usagePrepaidDraws.$inferSelect> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const grantId = uuidText(input.grantId, "grant_id");
    const runId = input.runId == null ? null : uuidText(input.runId, "run_id");
    const periodMonth = dateText(input.periodMonth, "period_month");
    if (periodMonth.slice(8, 10) !== "01") {
      refuse("usage_prepaid_period_invalid", "A prepaid draw period_month must be the first day of its month.", "Use YYYY-MM-01 as the draw period_month.", "period_month");
    }
    const amount = exactMoney(input.amount, "amount");
    if (cmp(amount, "0") <= 0) {
      refuse("usage_prepaid_amount_invalid", "A prepaid draw amount must be greater than zero.", "Provide a positive draw amount within the grant's remaining balance.", "amount");
    }
    await lockPrepaidRecognitionContract(orgId,grantId)
    const grant = (await db.execute<{ amount: string; expiresOn: string | null }>(sql`
      select g.amount::text as amount, g.expires_on::text as "expiresOn"
        from usage_prepaid_grants g
        join parties c on c.org_id = g.org_id and c.id = g.customer_id
       where g.org_id = ${orgId} and g.id = ${grantId}
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       for update of g, c`)).rows[0];
    if (!grant) {
      throw new ScopeNotFoundError();
    }
    if (grant.expiresOn !== null && periodMonth > grant.expiresOn) {
      refuse(
        "usage_prepaid_grant_expired",
        `The prepaid grant expired on ${grant.expiresOn} and cannot fund this usage period.`,
        "Use an unexpired prepaid grant for this usage period; expired balances remain liabilities until a supported, independently approved breakage assessment is applied through the Revenue contract.",
        "grant_id",
      );
    }
    const drawn = (await db.execute<{ amount: string }>(sql`
      select coalesce(sum(amount), 0)::text as amount
        from usage_prepaid_draws where org_id = ${orgId} and grant_id = ${grantId}`)).rows[0]?.amount ?? "0";
    const balance = subMoney(grant.amount, drawn);
    if (cmp(balance, amount) < 0) {
      refuse(
        "usage_prepaid_balance_exceeded",
        `The prepaid draw ${amount} exceeds the grant's remaining balance of ${balance}.`,
        "Reduce the draw to the remaining balance or select another unexpired prepaid grant.",
        "amount",
      );
    }
    try {
      const inserted = await db.execute<typeof usagePrepaidDraws.$inferSelect>(sql`
        insert into usage_prepaid_draws (org_id, grant_id, run_id, period_month, amount)
        values (${orgId}, ${grantId}, ${runId}, ${periodMonth}, ${amount})
        returning ${DRAW_COLUMNS}`);
      if (inserted.rows.length !== 1) throw new Error("prepaid draw insert returned an unexpected row count");
      await refreshPrepaidBreakage(orgId,grantId,periodMonth)
      return inserted.rows[0]!;
    } catch (error) {
      if (uniqueViolationFor(error, "usage_prepaid_draws_run_grant_period_unique")) {
        refuse("usage_prepaid_draw_duplicate", "This rating run already recorded a draw from the grant for this period.", "Reuse the existing draw for this run, or use a different run and period.", "run_id", 409);
      }
      throw error;
    }
  });
}

/** Internal append-only reversal writer used when a usage run is replaced. */
export async function reversePrepaidDraw(
  orgId: string,
  drawIdInput: string,
  allowedSubsidiaryIds: UsageSubsidiaryScope = null,
): Promise<typeof usagePrepaidDraws.$inferSelect> {
  return withOrg(orgId, async () => {
    await lockAndRequireUsageBilling(orgId);
    const drawId = uuidText(drawIdInput, "draw_id");
    const source = (await db.execute<{grant_id:string}>(sql`select grant_id from usage_prepaid_draws where org_id=${orgId} and id=${drawId}`)).rows[0]
    if (!source) throw new ScopeNotFoundError()
    await lockPrepaidRecognitionContract(orgId,source.grant_id)
    const original = (await db.execute<{
      id: string;
      grantId: string;
      runId: string | null;
      periodMonth: string;
      amount: string;
      reversesDrawId: string | null;
      subsidiaryId: string | null;
    }>(sql`
      select d.id, d.grant_id as "grantId", d.run_id as "runId",
             d.period_month::text as "periodMonth", d.amount::text as amount,
             d.reverses_draw_id as "reversesDrawId", c.subsidiary_id as "subsidiaryId"
        from usage_prepaid_draws d
        join usage_prepaid_grants g on g.org_id = d.org_id and g.id = d.grant_id
        join parties c on c.org_id = g.org_id and c.id = g.customer_id
       where d.org_id = ${orgId} and d.id = ${drawId}
         ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       for update of d, g, c`)).rows[0];
    if (!original) {
      throw new ScopeNotFoundError();
    }
    if (original.reversesDrawId !== null) {
      refuse("usage_prepaid_draw_reversal_not_allowed", "A prepaid draw reversal cannot itself be reversed.", "Choose the original positive draw; reversal entries are final.", "draw_id", 409);
    }
    const priorReversal = (await db.execute<{ id: string }>(sql`
      select id from usage_prepaid_draws
       where org_id = ${orgId} and reverses_draw_id = ${drawId}
       limit 1`)).rows[0];
    if (priorReversal) {
      refuse("usage_prepaid_draw_already_reversed", "This prepaid draw already has a reversal.", "Use the existing reversal entry; an original draw may be reversed only once.", "draw_id", 409);
    }
    const amount = negMoney(parseMoney(original.amount));
    const inserted = await db.execute<typeof usagePrepaidDraws.$inferSelect>(sql`
      insert into usage_prepaid_draws
        (org_id, grant_id, run_id, period_month, amount, reverses_draw_id)
      values (${orgId}, ${original.grantId}, ${original.runId}, ${original.periodMonth}, ${amount}, ${original.id})
      returning ${DRAW_COLUMNS}`);
    if (inserted.rows.length !== 1) throw new Error("prepaid draw reversal insert returned an unexpected row count");
    await refreshPrepaidBreakage(orgId,original.grantId,original.periodMonth)
    return inserted.rows[0]!;
  });
}
