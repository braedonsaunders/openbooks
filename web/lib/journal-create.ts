import {
  journalHeaderInstructionFields,
  journalLineInstructionFields,
} from "./journal-instructions";
import { validateJournalInstructions } from "@openbooks/engine/ledger/journal-instructions";
import { lookupExchangeRate } from "@openbooks/engine/fx/spot-rate";
import { accountingPreferences } from "@openbooks/engine/organization/accounting-preferences";
import { validateSavedAmortizationLines } from "@openbooks/engine/amortization";
import { journalAmortizationFields } from "@/lib/journal-amortization";
import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { sum, toUnits } from "@openbooks/engine/money/money";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { claimIdempotentCreate, resolveIdempotentReplay } from "./api/idempotency";
import { exactMoney, isoDate, nullableUuidId } from "./api/json";
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from "./custom-fields";
import { loadJournalDoc } from "./journals";
import { isUuid } from "./list-params";
import { segmentRegistry, validateExtraDims } from "./segments";
import { JournalBookError, resolveJournalBookTarget } from "./journal-book";
import { assertDocumentSegmentDependencies } from "@openbooks/engine/organization/segment-dependencies";

/**
 * The only first-party writer for a new manual journal with lines.
 * POST /api/journals and POST /api/v1/journals both terminate here — never
 * a second insert path to documents kind=journal.
 */

export class JournalCreateError extends Error {
  readonly name = "JournalCreateError";

  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJson(): Record<string, unknown> {
    return { error: this.message, ...this.payload };
  }
}

const journalLineInput = z
  .object({
    // Blank/malformed accounts pass the boundary so createManualJournal can
    // refuse them with the line number (a bare uuid failure names neither
    // the line nor the remedy).
    accountId: z.string().nullable().optional(),
    ...journalAmortizationFields,
    ...journalLineInstructionFields,
    description: z.string().nullable().optional(),
    amount: exactMoney(),
    partyId: nullableUuidId.optional(),
    departmentId: nullableUuidId.optional(),
    projectId: nullableUuidId.optional(),
    subsidiaryId: nullableUuidId.optional(),
    extraDims: z.record(z.string(), z.string().nullable()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (line) =>
      toUnits(line.amount) !== 0n || (line.quantity !== undefined && toUnits(line.quantity) !== 0n),
    "journal line amounts cannot be zero",
  );

export const journalCreateBody = z.object({
  ...journalHeaderInstructionFields,
  partyId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  subsidiaryId: nullableUuidId.optional(),
  /** Book-specific journal target; omitted or null posts to every book. */
  accountingBookId: nullableUuidId.optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  lines: z.array(journalLineInput).optional(),
});

export type JournalCreateBody = z.infer<typeof journalCreateBody>;

function fail(error: string, field?: string, status = 422): never {
  throw new JournalCreateError(error, status, field ? { field } : {});
}

function subsidiariesAllowed(
  allowed: ReadonlySet<string> | null,
  ids: readonly (string | null | undefined)[],
): boolean {
  if (allowed === null) return true;
  return ids.every((id) => id !== null && id !== undefined && id !== "" && allowed.has(id));
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function createManualJournal(input: {
  orgId: string;
  userId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  idempotencyKey: string;
  body: JournalCreateBody;
  /** Whether the caller holds gl.post_book_specific. */
  canPostBookSpecific?: boolean;
}): Promise<{
  created: boolean;
  journal: NonNullable<Awaited<ReturnType<typeof loadJournalDoc>>>;
}> {
  if (!isUuid(input.idempotencyKey)) fail("invalid_idempotency_key", undefined, 400);

  const { orgId, userId, body } = input;
  const requestId = input.idempotencyKey;
  const lines = body.lines ?? [];
  if (lines.length === 0) fail("add at least one journal line", "lines");
  const totalDebits = sum(lines.map((line) => (toUnits(line.amount) > 0n ? line.amount : "0")));
  const net = sum(lines.map((line) => line.amount));
  const mode = body.journalMode ?? "monetary";
  const mixed = lines.some((line) => line.currency && line.currency !== body.currency);
  if (mode !== "statistical" && (toUnits(totalDebits) <= 0n || (!mixed && toUnits(net) !== 0n))) {
    fail("journal lines must balance with a non-zero total", "lines");
  }

  let subsidiary: { id: string; base_currency: string };
  if (body.subsidiaryId) {
    if (input.allowedSubsidiaryIds !== null && !input.allowedSubsidiaryIds.has(body.subsidiaryId)) {
      throw new JournalCreateError("not found", 404);
    }
    const explicit = (
      await db.execute<{ id: string; base_currency: string }>(
        sql`
      select id, base_currency from subsidiaries
       where org_id = ${orgId} and id = ${body.subsidiaryId}
         and is_active and not is_elimination`,
        "objects",
      )
    )[0];
    if (!explicit) fail("invalid subsidiary", "subsidiaryId");
    subsidiary = explicit;
  } else if (input.allowedSubsidiaryIds === null) {
    const root = await db.execute<{ id: string; base_currency: string }>(
      sql`
      select id, base_currency from subsidiaries where org_id = ${orgId} and parent_id is null`,
      "objects",
    );
    if (!root[0]) fail("org has no root subsidiary", undefined, 500);
    subsidiary = root[0];
  } else {
    const ids = [...input.allowedSubsidiaryIds].filter((id) => isUuid(id));
    const allowed = ids.length
      ? await db.execute<{ id: string; base_currency: string }>(
          sql`
          select id, base_currency from subsidiaries
           where org_id = ${orgId} and is_active and not is_elimination
             and id = any(${`{${ids.join(",")}}`}::uuid[])`,
          "objects",
        )
      : [];
    if (allowed.length === 0) fail("no_available_subsidiary", undefined, 409);
    if (allowed.length !== 1) fail("subsidiary_selection_required", "subsidiaryId", 409);
    subsidiary = allowed[0]!;
  }

  let bookTarget: Awaited<ReturnType<typeof resolveJournalBookTarget>>;
  try {
    bookTarget = await resolveJournalBookTarget({
      orgId,
      requested: body.accountingBookId ?? null,
      subsidiaryId: subsidiary.id,
      canPostBookSpecific: input.canPostBookSpecific === true,
    });
  } catch (error) {
    if (error instanceof JournalBookError) fail(error.message, "accountingBookId", error.status);
    throw error;
  }

  const documentDate = body.documentDate ?? (await businessToday(orgId));
  const currency = body.currency ?? bookTarget.currency;
  const preference = await accountingPreferences(db, orgId, subsidiary.id, documentDate);
  const fxRate =
    body.fxRate ??
    (currency === bookTarget.currency
      ? "1"
      : await lookupExchangeRate(
          db,
          orgId,
          currency,
          bookTarget.currency,
          documentDate,
          preference.postingRateType,
        ));
  if (!fxRate)
    fail(
      `No ${preference.postingRateType} rate converts ${currency} to ${bookTarget.currency}. Enter the dated exchange rate or supply its exact rate.`,
      "fxRate",
    );

  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs("documents", "journal"),
    loadFieldDefs("document_lines", "journal"),
    segmentRegistry(orgId),
  ]);
  const headerDims = validateExtraDims(body.extraDims, segments);
  if (!headerDims.ok) fail(headerDims.error);
  const headerCustomResult = validateCustomValues(headerDefs, body.custom ?? {});
  if (!headerCustomResult.ok) {
    throw new JournalCreateError(String(Object.values(headerCustomResult.errors)[0]), 422, {
      fieldErrors: headerCustomResult.errors,
    });
  }
  const unownedHeaderRefs = await findUnownedCustomReferences(
    orgId,
    headerDefs,
    headerCustomResult.cleaned,
  );
  if (unownedHeaderRefs.length > 0) {
    throw new JournalCreateError(
      `${unownedHeaderRefs[0]!.label} not found in this organization`,
      404,
    );
  }

  const partyId = body.partyId ?? null;
  if (partyId) {
    const party = await db.execute<{ id: string }>(
      sql`
      select id from parties where id = ${partyId} and org_id = ${orgId} and is_active`,
      "objects",
    );
    if (!party[0]) throw new JournalCreateError("party not found in this organization", 404);
  }
  const requestedSubsidiaries = [
    ...new Set(lines.flatMap((line) => (line.subsidiaryId ? [line.subsidiaryId] : []))),
  ];
  if (
    requestedSubsidiaries.length &&
    !subsidiariesAllowed(input.allowedSubsidiaryIds, requestedSubsidiaries)
  ) {
    fail("invalid subsidiary", "lines");
  }
  if (requestedSubsidiaries.length) {
    const owned = await db.execute(
      sql`
      select id from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(",")}}`}::uuid[])`,
      "objects",
    );
    if (owned.length !== requestedSubsidiaries.length) fail("invalid subsidiary", "lines");
  }
  // Every submitted leg must name its account: the drawers send every
  // contentful row, so an account-less row arrives here rather than
  // vanishing client-side — name its line instead of booking without it.
  // Malformed ids get the same line-numbered treatment the boundary's
  // anonymous uuid failure never gave them. This runs before the ownership
  // lookup below, whose uuid[] cast cannot take a blank.
  const checkedAccountIds = lines.map((line, i) => {
    const accountId = line.accountId;
    if (typeof accountId !== "string" || accountId.trim() === "") {
      throw new JournalCreateError(`Line ${i + 1}: an account is required`, 422);
    }
    if (!isUuid(accountId)) {
      throw new JournalCreateError(`Line ${i + 1}: invalid account`, 422);
    }
    return accountId;
  });
  const lineAccountIds = [...new Set(checkedAccountIds)];
  const ownedAccounts = await db.execute<{ id: string }>(
    sql`
    select id from accounts
     where org_id = ${orgId} and id = any(${`{${lineAccountIds.join(",")}}`}::uuid[])`,
    "objects",
  );
  if (ownedAccounts.length !== lineAccountIds.length) {
    throw new JournalCreateError("account not found in this organization", 404);
  }
  for (const ref of [
    {
      ids: lines.map((line) => line.departmentId).filter(Boolean) as string[],
      table: "departments",
    },
    { ids: lines.map((line) => line.projectId).filter(Boolean) as string[], table: "projects" },
    { ids: lines.map((line) => line.partyId).filter(Boolean) as string[], table: "parties" },
  ]) {
    if (!ref.ids.length) continue;
    const unique = [...new Set(ref.ids)];
    const found = await db.execute(
      sql`
      select id from ${sql.raw(ref.table)}
       where org_id = ${orgId} and id = any(${`{${unique.join(",")}}`}::uuid[])`,
      "objects",
    );
    if (found.length !== unique.length) {
      throw new JournalCreateError(`${ref.table} reference not found in this organization`, 404);
    }
  }

  const preparedLines: {
    currency: string | null;
    fxRate: string | null;
    quantity: string;
    unit: string | null;
    eliminate: boolean;
    amortizationTemplateId: string | null;
    amortizationStartOn: string | null;
    amortizationEndOn: string | null;
    accountId: string;
    description: string | null;
    amount: string;
    partyId: string | null;
    departmentId: string | null;
    projectId: string | null;
    subsidiaryId: string | null;
    extraDims: Record<string, string | null>;
    custom: Record<string, unknown>;
  }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const validated = validateCustomValues(lineDefs, line.custom);
    if (!validated.ok) {
      throw new JournalCreateError(`Line ${i + 1}: ${Object.values(validated.errors)[0]}`, 422, {
        fieldErrors: validated.errors,
      });
    }
    const unownedLineRefs = await findUnownedCustomReferences(orgId, lineDefs, validated.cleaned);
    if (unownedLineRefs.length > 0) {
      throw new JournalCreateError(
        `Line ${i + 1}: ${unownedLineRefs[0]!.label} not found in this organization`,
        404,
      );
    }
    const lineDims = validateExtraDims(line.extraDims, segments);
    if (!lineDims.ok) fail(`Line ${i + 1}: ${lineDims.error}`, "lines");
    preparedLines.push({
      currency: line.currency ?? null,
      fxRate: line.fxRate ?? null,
      quantity: line.quantity ?? "1",
      unit: line.unit ?? null,
      eliminate: line.eliminate ?? false,
      accountId: checkedAccountIds[i]!,
      description: line.description ?? null,
      amount: line.amount,
      amortizationTemplateId: line.amortizationTemplateId ?? null,
      amortizationStartOn: line.amortizationStartOn ?? null,
      amortizationEndOn: line.amortizationEndOn ?? null,
      partyId: line.partyId ?? null,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      subsidiaryId: line.subsidiaryId ?? null,
      extraDims: lineDims.cleaned,
      custom: validated.cleaned,
    });
  }

  const referenceNumber = trimOrNull(body.referenceNumber);
  const memo = trimOrNull(body.memo);
  const match = {
    kind: "journal",
    ...(body.journalMode !== undefined ? { journalMode: body.journalMode } : {}),
    ...(body.journalReverseOn !== undefined ? { journalReverseOn: body.journalReverseOn } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    ...(body.fxRate !== undefined ? { fxRate: body.fxRate } : {}),
    partyId: body.partyId ?? null,
    documentDate: body.documentDate ?? null,
    referenceNumber: body.referenceNumber ?? null,
    memo: body.memo ?? null,
    subsidiaryId: body.subsidiaryId ?? null,
    ...(body.accountingBookId ? { accountingBookId: body.accountingBookId } : {}),
    extraDims: body.extraDims ?? null,
    custom: body.custom ?? null,
    lines: body.lines ?? [],
  };
  const snapshot = {
    request: match,
    id: requestId,
    org_id: orgId,
    kind: "journal",
    subsidiary_id: subsidiary.id,
    document_date: documentDate,
    currency,
    fx_rate: fxRate,
    journal_fx_rate_explicit: body.fxRate !== undefined || currency !== bookTarget.currency,
    journal_mode: mode,
    journal_reverse_on: body.journalReverseOn ?? null,
    accounting_book_id: bookTarget.accountingBookId,
    party_id: partyId,
    reference_number: referenceNumber,
    memo,
    extra_dims: headerDims.cleaned,
    custom: headerCustomResult.cleaned,
    subtotal: totalDebits,
    total: totalDebits,
    lines: preparedLines.map((line, index) => ({
      line_number: index + 1,
      account_id: line.accountId,
      journal_currency: line.currency,
      journal_fx_rate: line.fxRate,
      journal_eliminate: line.eliminate,
      quantity: line.quantity,
      unit: line.unit,
      amortization_template_id: line.amortizationTemplateId,
      amortization_start_on: line.amortizationStartOn,
      amortization_end_on: line.amortizationEndOn,
      description: line.description,
      amount: line.amount,
      party_id: line.partyId,
      department_id: line.departmentId,
      project_id: line.projectId,
      subsidiary_id: line.subsidiaryId,
      extra_dims: line.extraDims,
      custom: line.custom,
    })),
  };

  let created = false;
  try {
    created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const claim = await claimIdempotentCreate(tx, { orgId, table: "documents", key: requestId });
      const replayMatch = { request: match };
      if (claim === "exists") {
        const replay = await resolveIdempotentReplay(tx, {
          orgId,
          table: "documents",
          key: requestId,
          match: replayMatch,
        });
        if (replay !== "replay") throw new Error("idempotency_key_conflict");
        return false;
      }
      const documentNumber = await allocateDocumentNumber(tx, orgId, "journal", "JE-");
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into documents
          (id, org_id, kind, status, subsidiary_id, document_number, document_date,
           currency, fx_rate, journal_fx_rate_explicit, journal_mode, journal_reverse_on, accounting_book_id, party_id, reference_number, memo, extra_dims, custom,
           subtotal, tax_total, total, created_by, updated_by)
        values
          (${requestId}, ${orgId}, 'journal', 'draft', ${subsidiary.id}, ${documentNumber},
           ${documentDate}, ${currency}, ${fxRate}, ${body.fxRate !== undefined || currency !== bookTarget.currency}, ${mode}, ${body.journalReverseOn ?? null}, ${bookTarget.accountingBookId}, ${partyId}, ${referenceNumber}, ${memo},
           ${JSON.stringify(headerDims.cleaned)}::jsonb, ${JSON.stringify(headerCustomResult.cleaned)}::jsonb,
           ${totalDebits}, '0', ${totalDebits}, ${userId}, ${userId})
        -- Lost insert race or a foreign/global UUID collision: the re-read
        -- below decides replay vs conflict without reading another org's row.
        on conflict (id) do nothing
        returning id`,
        "objects",
      );
      if (!inserted[0]) {
        const replay = await resolveIdempotentReplay(tx, {
          orgId,
          table: "documents",
          key: requestId,
          match: replayMatch,
        });
        if (replay !== "replay") throw new Error("idempotency_key_conflict");
        return false;
      }
      for (let i = 0; i < preparedLines.length; i++) {
        const line = preparedLines[i]!;
        const savedLine = await tx.execute<{ id: string }>(
          sql`
          insert into document_lines (org_id, document_id, line_number, account_id, description,
                                      quantity, unit, journal_currency, journal_fx_rate, journal_eliminate, unit_price, amount, party_id, department_id, project_id,
                                      subsidiary_id, extra_dims, custom, amortization_template_id, amortization_start_on, amortization_end_on)
          values (${orgId}, ${requestId}, ${i + 1}, ${line.accountId}, ${line.description},
                  ${line.quantity}, ${line.unit}, ${line.currency}, ${line.fxRate}, ${line.eliminate}, ${line.amount}, ${line.amount}, ${line.partyId}, ${line.departmentId}, ${line.projectId},
                  ${line.subsidiaryId}, ${JSON.stringify(line.extraDims)}::jsonb, ${JSON.stringify(line.custom)}::jsonb, ${line.amortizationTemplateId}, ${line.amortizationStartOn}, ${line.amortizationEndOn}) returning id`,
          "objects",
        );
        if (savedLine.length !== 1)
          throw new JournalCreateError(`Line ${i + 1} could not be saved`, 409);
      }
      // Segment value dependencies on the saved lines, as posting will read them.
      await assertDocumentSegmentDependencies(tx, orgId, requestId);
      await validateSavedAmortizationLines(tx, orgId, requestId);
      const totals = await validateJournalInstructions(tx, orgId, requestId);
      const measured = await tx.execute(
        sql`update documents set subtotal=${totals.debits},total=${totals.debits}
        where org_id=${orgId} and id=${requestId} and status='draft' returning id`,
        "objects",
      );
      if (measured.length !== 1)
        throw new JournalCreateError("The journal's header-currency total could not be saved", 409);
      snapshot.subtotal = totals.debits;
      snapshot.total = totals.debits;
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${orgId}, 'documents', ${requestId}, 'insert',
                ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
                ${userId}, ${requestId})`);
      return true;
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`
        : String(error);
    if (message.includes("idempotency_key_conflict"))
      fail("invalid_idempotency_key", undefined, 409);
    throw error;
  }

  const journal = await loadJournalDoc(requestId, orgId, input.allowedSubsidiaryIds);
  if (!journal) fail("save_failed", undefined, 500);
  return { created, journal };
}
