import { sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { NonprofitError } from "./errors.ts";

const FEATURE = "nonprofit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER = "nonprofitGift";
const MAX_NUMERIC_19_4_UNITS = 9_999_999_999_999_999_999n;
type EntryNumberTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GiftKind = "cash" | "check" | "card" | "stock" | "in_kind_goods" | "in_kind_services" | "other";
export type FairValueBasis = "appraisal" | "donor_stated" | "market";
export type TributeKind = "none" | "in_honor_of" | "in_memory_of";
const GIFT_KINDS: readonly GiftKind[] = ["cash", "check", "card", "stock", "in_kind_goods", "in_kind_services", "other"];
const BASES: readonly FairValueBasis[] = ["appraisal", "donor_stated", "market"];
const TRIBUTES: readonly TributeKind[] = ["none", "in_honor_of", "in_memory_of"];

export interface CreateGiftInput {
  orgId: string;
  subsidiaryId: string;
  donorPartyId?: string | null;
  fundId: string;
  amount: string;
  kind: GiftKind;
  fairValueBasis?: FairValueBasis | null;
  tributeKind?: TributeKind;
  tributeName?: string | null;
  tributeNotifyPartyId?: string | null;
  receivedOn: string;
  reason: string;
  custom?: Record<string, unknown>;
  actorId?: string | null;
}
interface GiftRow extends Record<string, unknown> {
  id: string;
  gift_number: string;
  org_id: string;
  subsidiary_id: string;
  donor_party_id: string | null;
  fund_id: string;
  amount: string;
  kind: GiftKind;
  fair_value_basis: FairValueBasis | null;
  tribute_kind: TributeKind;
  tribute_name: string | null;
  tribute_notify_party_id: string | null;
  receipt_number: string | null;
  received_on: string;
  status: string;
  posted_entry_id: string | null;
}
function fail(input: {
  message: string; code: string; remedy: string; status?: 409 | 422; field?: string;
}): NonprofitError {
  return new NonprofitError({
    message: input.message, status: input.status ?? 422, code: input.code, remedy: input.remedy,
    ...(input.field ? { field: input.field } : {}),
  });
}
function featureOff(): NonprofitError {
  return fail({
    message: "Nonprofit contributions are disabled; enable Nonprofit in Company Settings → Features.",
    code: "feature_off", remedy: "Enable Nonprofit in Company Settings → Features.",
  });
}
async function lockFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) throw featureOff();
}
function uuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) throw fail({
    message: field + " must identify a valid record.", code: "gift_reference_invalid",
    remedy: "Choose an existing record for " + field + ".", field,
  });
}
function date(value: string, field: string): void {
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!DATE_RE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail({
      message: field + " must be a valid calendar date.", code: "gift_date_invalid",
      remedy: "Enter a valid YYYY-MM-DD date for " + field + ".", field,
    });
  }
}
function money(value: string): string {
  try { return fromUnits(toUnits(value)); } catch {
    throw fail({
      message: "Gift amount must be a decimal with no more than four places.",
      code: "gift_amount_invalid", remedy: "Enter a positive amount for the gift.", field: "amount",
    });
  }
}
function reason(value: string): string {
  const clean = value.trim();
  if (clean.length < 5 || clean.length > 500) throw fail({
    message: "A reason between 5 and 500 characters is required.", code: "gift_reason_required",
    remedy: "Enter the business reason for this gift change.", field: "reason",
  });
  return clean;
}
async function audit(input: {
  orgId: string; id: string; action: string; actorId?: string | null;
  before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'gifts', ${input.id}, ${input.action},
      ${JSON.stringify({
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })}::jsonb, ${input.actorId ?? null})`);
}
async function readGift(orgId: string, id: string, lock = false): Promise<GiftRow | null> {
  const row = await db.execute<GiftRow>(sql`
    select id, gift_number, org_id, subsidiary_id, donor_party_id, fund_id, amount::text as amount,
      kind, fair_value_basis, tribute_kind, tribute_name, tribute_notify_party_id, receipt_number,
      received_on::text as received_on, status, posted_entry_id
      from gifts where org_id = ${orgId} and id = ${id}
      ${sql.raw(lock ? "for update" : "")}`);
  return row.rows[0] ?? null;
}
async function postGiftEntry(input: {
  gift: GiftRow; postingDate: string; debitAccountId: string; contributionsAccountId: string;
  actorId?: string | null; reason: string; reversalOf?: string;
}) {
  const period = await resolveCoveringPeriod(db, input.gift.org_id, input.postingDate);
  if (!period) throw fail({
    message: "No open accounting period covers " + input.postingDate + ".",
    status: 409, code: "gift_period_unavailable", remedy: "Open the GL period covering the gift posting date.",
  });
  const book = (await db.execute<{ id: string; currency: string }>(sql`
    select b.id, s.base_currency as currency from accounting_books b
    join subsidiaries s on s.org_id = b.org_id and s.id = ${input.gift.subsidiary_id}
     where b.org_id = ${input.gift.org_id} and b.is_primary and b.is_active and b.posts_gl limit 1`)).rows[0];
  if (!book) throw fail({
    message: "The gift's subsidiary has no active primary GL book.",
    status: 409, code: "gift_book_unavailable",
    remedy: "Configure an active primary GL book and subsidiary currency.",
  });
  const preferred = input.reversalOf
    ? input.reversalOf + "-REV"
    : input.gift.gift_number + "-POST";
  const entryNumber = await nextFreeEntryNumber(
    db as unknown as EntryNumberTx, input.gift.org_id, preferred,
  );
  return postEntry(db, {
    orgId: input.gift.org_id, bookId: book.id, subsidiaryId: input.gift.subsidiary_id,
    entryNumber, postingDate: input.postingDate, periodId: period.id,
    memo: "Gift " + input.gift.gift_number, origin: "gift", actorId: input.actorId,
    reversesEntryId: input.reversalOf,
    idempotencyKey: input.reversalOf ? undefined : "gift-posted:" + input.gift.id,
    custom: { [MARKER]: { giftId: input.gift.id, operation: input.reversalOf ? "void_reversal" : "post" } },
    auditAction: input.reversalOf ? "reverse" : "post",
    auditChanges: { giftId: input.gift.id, receiptNumber: input.gift.receipt_number, reason: input.reason },
    lines: [
      {
        accountId: input.debitAccountId, amount: input.gift.amount, currency: book.currency,
        extraDims: { fund: input.gift.fund_id },
      },
      {
        accountId: input.contributionsAccountId, amount: fromUnits(-toUnits(input.gift.amount)),
        currency: book.currency, extraDims: { fund: input.gift.fund_id },
      },
    ],
  });
}

export async function createGift(input: CreateGiftInput): Promise<{
  id: string; giftNumber: string; status: "draft"; amount: string;
}> {
  uuid(input.orgId, "orgId");
  uuid(input.subsidiaryId, "subsidiaryId");
  uuid(input.fundId, "fundId");
  if (input.donorPartyId) uuid(input.donorPartyId, "donorPartyId");
  if (input.tributeNotifyPartyId) uuid(input.tributeNotifyPartyId, "tributeNotifyPartyId");
  date(input.receivedOn, "receivedOn");
  const why = reason(input.reason);
  const amount = money(input.amount);
  if (toUnits(amount) <= 0n) throw fail({
    message: "Gift amount must be greater than zero.", code: "gift_amount_nonpositive",
    remedy: "Enter a positive fair value for the gift.", field: "amount",
  });
  if (toUnits(amount) > MAX_NUMERIC_19_4_UNITS) throw fail({
    message: "The gift amount exceeds the supported ledger precision.",
    code: "gift_amount_out_of_range",
    remedy: "Enter a gift amount within the supported 19-digit ledger range.", field: "amount",
  });
  if (!GIFT_KINDS.includes(input.kind)) throw fail({
    message: "The gift kind is not supported.", code: "gift_kind_invalid",
    remedy: "Choose a supported gift kind.", field: "kind",
  });
  const inKind = input.kind === "in_kind_goods" || input.kind === "in_kind_services";
  if (inKind && !input.fairValueBasis) throw fail({
    message: "An in-kind gift needs a fair-value basis before it can be recorded.",
    code: "gift_fair_value_basis_required", remedy: "Record the fair-value basis for this gift.",
    field: "fairValueBasis",
  });
  if (input.fairValueBasis && !BASES.includes(input.fairValueBasis)) throw fail({
    message: "The fair-value basis is not supported.", code: "gift_fair_value_basis_invalid",
    remedy: "Choose appraisal, donor-stated, or market evidence.", field: "fairValueBasis",
  });
  const tributeKind = input.tributeKind ?? "none";
  if (!TRIBUTES.includes(tributeKind)) throw fail({
    message: "The tribute kind is not supported.", code: "gift_tribute_kind_invalid",
    remedy: "Choose no tribute, in honor of, or in memory of.", field: "tributeKind",
  });
  const tributeName = input.tributeName?.trim() || null;
  const notifyPartyId = input.tributeNotifyPartyId ?? null;
  if (tributeKind === "none" && (tributeName || notifyPartyId)) throw fail({
    message: "Tribute details require a tribute kind.", code: "gift_tribute_details_invalid",
    remedy: "Choose a tribute kind or remove the tribute details.", field: "tributeKind",
  });
  if (tributeKind !== "none" && !tributeName) throw fail({
    message: "A tribute name is required for an honor or memory gift.",
    code: "gift_tribute_name_required", remedy: "Enter the tribute name.", field: "tributeName",
  });
  if (input.custom !== undefined && (
    input.custom === null || typeof input.custom !== "object" || Array.isArray(input.custom)
  )) throw fail({
    message: "Custom gift data must be an object.", code: "gift_custom_invalid",
    remedy: "Provide custom gift fields as a JSON object.", field: "custom",
  });
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const references = await db.execute<{ id: string }>(sql`
      select s.id from subsidiaries s join funds f on f.org_id = s.org_id
       where s.org_id = ${input.orgId} and s.id = ${input.subsidiaryId}
         and f.id = ${input.fundId}
         and exists (
           select 1 from segment_values sv join segment_definitions sd
             on sd.org_id = sv.org_id and sd.id = sv.segment_id
            where sv.org_id = f.org_id and sv.id = f.id and sv.is_active
              and sd.key = 'fund' and sd.source_kind = 'custom')
         and (${input.donorPartyId ?? null}::uuid is null or exists (
           select 1 from parties p where p.org_id = s.org_id and p.id = ${input.donorPartyId ?? null}))
         and (${notifyPartyId}::uuid is null or exists (
           select 1 from parties p where p.org_id = s.org_id and p.id = ${notifyPartyId}))`);
    if (references.rows.length !== 1) throw fail({
      message: "The fund, subsidiary, donor, or tribute contact is not in this organization.",
      code: "gift_reference_not_found",
      remedy: "Choose active gift references from this organization.",
    });
    const giftNumber = await allocateDocumentNumber(db, input.orgId, "gift", "GFT-");
    const inserted = await db.execute<{ id: string }>(sql`
      insert into gifts (
        org_id, subsidiary_id, gift_number, donor_party_id, fund_id, amount, kind, fair_value_basis,
        tribute_kind, tribute_name, tribute_notify_party_id, received_on, status, custom, created_by, updated_by
      ) values (
        ${input.orgId}, ${input.subsidiaryId}, ${giftNumber}, ${input.donorPartyId ?? null},
        ${input.fundId}, ${amount}, ${input.kind}, ${input.fairValueBasis ?? null},
        ${tributeKind}, ${tributeName}, ${notifyPartyId}, ${input.receivedOn}, 'draft',
        ${JSON.stringify(input.custom ?? {})}::jsonb, ${input.actorId ?? null}, ${input.actorId ?? null}
      ) returning id`);
    const id = inserted.rows[0]?.id;
    if (!id) throw fail({
      message: "The gift record was not created.", status: 409,
      code: "gift_write_missing", remedy: "Retry the gift after checking its organization references.",
    });
    await audit({
      orgId: input.orgId, id, action: "create", actorId: input.actorId,
      after: {
        giftNumber, donorPartyId: input.donorPartyId ?? null, fundId: input.fundId,
        amount, kind: input.kind, fairValueBasis: input.fairValueBasis ?? null,
        tributeKind, receivedOn: input.receivedOn, status: "draft",
      },
      reason: why,
    });
    return { id, giftNumber, status: "draft", amount };
  });
}

export async function receiptGift(input: {
  orgId: string; giftId: string; actorId?: string | null; reason: string;
}): Promise<{ receiptNumber: string; status: "receipted" }> {
  uuid(input.giftId, "giftId");
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const gift = await readGift(input.orgId, input.giftId, true);
    if (!gift || gift.status !== "draft" || gift.receipt_number) throw fail({
      message: "Only a draft gift without a receipt number can be receipted.",
      status: 409, code: "gift_state_conflict", remedy: "Receipt a draft gift once before posting it.",
    });
    const receiptNumber = await allocateDocumentNumber(db, input.orgId, "gift_receipt", "RCPT-");
    const updated = (await db.execute<{ id: string }>(sql`
      update gifts set receipt_number = ${receiptNumber}, status = 'receipted',
        updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${gift.id} and status = 'draft' and receipt_number is null
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "The gift receipt number was not saved.", status: 409,
      code: "gift_receipt_write_missing", remedy: "Refresh the gift and retry receipting.",
    });
    await audit({
      orgId: input.orgId, id: gift.id, action: "receipt", actorId: input.actorId,
      before: { status: "draft", receiptNumber: null },
      after: { status: "receipted", receiptNumber }, reason: why,
    });
    return { receiptNumber, status: "receipted" };
  });
}

export async function postGift(input: {
  orgId: string; giftId: string; postingDate: string; debitAccountId: string;
  contributionsAccountId: string; reason: string; actorId?: string | null;
}): Promise<{ entryId: string; status: "posted" }> {
  uuid(input.giftId, "giftId");
  uuid(input.debitAccountId, "debitAccountId");
  uuid(input.contributionsAccountId, "contributionsAccountId");
  date(input.postingDate, "postingDate");
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const gift = await readGift(input.orgId, input.giftId, true);
    if (!gift || gift.status !== "receipted" || !gift.receipt_number) throw fail({
      message: "Only a receipted gift can be posted.",
      status: 409, code: "gift_state_conflict", remedy: "Assign the engine receipt number before posting the gift.",
    });
    if (
      (gift.kind === "in_kind_goods" || gift.kind === "in_kind_services") && !gift.fair_value_basis
    ) throw fail({
      message: "An in-kind gift needs a fair-value basis before posting.",
      code: "gift_fair_value_basis_required", remedy: "Record the fair-value basis for this gift.",
      field: "fairValueBasis",
    });
    const posted = await postGiftEntry({
      gift, postingDate: input.postingDate, debitAccountId: input.debitAccountId,
      contributionsAccountId: input.contributionsAccountId, actorId: input.actorId, reason: why,
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update gifts set posted_entry_id = ${posted.entryId}, status = 'posted',
        updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${gift.id} and status = 'receipted'
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Gift changed before its posting could be recorded.", status: 409,
      code: "gift_post_write_missing", remedy: "Refresh the gift and retry posting.",
    });
    await audit({
      orgId: input.orgId, id: gift.id, action: "post", actorId: input.actorId,
      before: { status: "receipted" }, after: { status: "posted", entryId: posted.entryId }, reason: why,
    });
    return { entryId: posted.entryId, status: "posted" };
  });
}

export async function voidGift(input: {
  orgId: string; giftId: string; reversalDate: string; reason: string; actorId?: string | null;
}): Promise<{ reversalEntryId: string | null; status: "void" }> {
  uuid(input.giftId, "giftId");
  date(input.reversalDate, "reversalDate");
  const why = reason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockFeature(input.orgId);
    const gift = await readGift(input.orgId, input.giftId, true);
    if (!gift || !["draft", "receipted", "posted"].includes(gift.status)) throw fail({
      message: "This gift cannot be voided from its current state.",
      status: 409, code: "gift_state_conflict", remedy: "Refresh the gift and use its current lifecycle action.",
    });
    let reversalEntryId: string | null = null;
    if (gift.status === "posted") {
      if (!gift.posted_entry_id) throw fail({
        message: "The posted gift has no linked journal entry.",
        status: 409, code: "gift_posting_missing", remedy: "Inspect the gift record before voiding it.",
      });
      const source = (await db.execute<{
        id: string; book_id: string; subsidiary_id: string; entry_number: string; status: string;
      }>(sql`
        select id, book_id, subsidiary_id, entry_number, status from journal_entries
         where org_id = ${input.orgId} and id = ${gift.posted_entry_id} for update`)).rows[0];
      if (!source || source.status !== "posted") throw fail({
        message: "The gift's journal entry is not posted and cannot be reversed.",
        status: 409, code: "gift_posting_not_reversible", remedy: "Use the journal correction workflow.",
      });
      const period = await resolveCoveringPeriod(db, input.orgId, input.reversalDate);
      if (!period) throw fail({
        message: "No open accounting period covers " + input.reversalDate + ".",
        status: 409, code: "gift_period_unavailable", remedy: "Open the GL period covering the gift reversal date.",
      });
      const lines = await db.select().from(schema.journalLines)
        .where(sql`org_id = ${input.orgId} and entry_id = ${source.id}`)
        .orderBy(schema.journalLines.lineNumber);
      if (!lines.length) throw fail({
        message: "The gift's journal entry has no lines.",
        status: 409, code: "gift_posting_lines_missing", remedy: "Inspect the journal entry before voiding the gift.",
      });
      const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
      const posted = await postEntry(db, {
        orgId: input.orgId, bookId: source.book_id, subsidiaryId: source.subsidiary_id,
        entryNumber: await nextFreeEntryNumber(
          db as unknown as EntryNumberTx, input.orgId, source.entry_number + "-REV",
        ),
        postingDate: input.reversalDate, periodId: period.id,
        memo: "Void gift " + gift.gift_number + ": " + why,
        origin: "gift", reversesEntryId: source.id, actorId: input.actorId,
        auditAction: "reverse",
        auditChanges: { mode: "gift_void", giftId: gift.id, reason: why },
        lines: mirror.map((line) => ({
          accountId: line.accountId, subsidiaryId: line.subsidiaryId, amount: line.amount,
          currency: line.currency, txnAmount: line.txnAmount, fxRate: line.fxRate, memo: line.memo,
          partyId: line.partyId, departmentId: line.departmentId, projectId: line.projectId,
          locationId: line.locationId, classId: line.classId,
          extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
          custom: (line.custom ?? {}) as Record<string, unknown>, lineNumber: line.lineNumber,
        })),
      });
      await markEntryReversed(db, { orgId: input.orgId, entryId: source.id, actorId: input.actorId });
      reversalEntryId = posted.entryId;
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update gifts set status = 'void', updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${gift.id} and status = ${gift.status}
      returning id`)).rows[0];
    if (!updated) throw fail({
      message: "Gift changed before voiding could be recorded.", status: 409,
      code: "gift_void_write_missing", remedy: "Refresh the gift and retry voiding.",
    });
    await audit({
      orgId: input.orgId, id: gift.id, action: "void", actorId: input.actorId,
      before: { status: gift.status, postedEntryId: gift.posted_entry_id },
      after: { status: "void", reversalEntryId }, reason: why,
    });
    return { reversalEntryId, status: "void" };
  });
}
