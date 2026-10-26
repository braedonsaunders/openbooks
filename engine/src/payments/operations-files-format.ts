import { guardCsvCell } from "@openbooks/reports";
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  nachaFileIdModifierForRunNumber,
  validateNachaSettings,
  type NachaSettings,
} from "../payments-core/rail-nacha.ts";
import { validateSepaSettings, type SepaSettings } from "../payments-core/rail-sepa.ts";
import { decryptAccountNumber, isValidBic, isValidIban } from "../payments-core/rail-settings.ts";
import { asciiRailText, ORIGINATOR_REMEDY, PAYEE_NAME_REMEDY } from "../payments-core/rail-text.ts";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { runScript } from "../scripting/scripting.ts";
import { loadRunFile, type RunFileOptions } from "./run-files.ts";
import { assertPaymentPartiesInScope, lockRunBankEvidence } from "./run-readiness.ts";

export interface FormatContext {
  run: Record<string, unknown>;
  profile: {
    id: string;
    name: string;
    settings: Record<string, unknown>;
    secrets: Record<string, unknown>;
  };
  format: {
    id: string;
    code: string;
    rail: string;
    extension: string;
    contentType: string;
    formatterScript: string | null;
  };
  payments: Array<{
    id: string;
    amount: string;
    currency: string;
    partyId: string;
    partyName: string;
    accountNumber: string;
    routing: Record<string, string>;
    reference: string;
    mandateReference: string | null;
  }>;
  /** The org's business day — the formatters' default when the run has no scheduled date. */
  businessDate: string;
}

export async function loadFormatContext(runId: string, orgId: string): Promise<FormatContext> {
  const rows = await db.execute<
    Record<string, unknown> & {
      id: string;
      payment_bank_profile_id: string;
      profile_name: string;
      profile_settings: Record<string, unknown>;
      originator_secrets_encrypted: string | null;
      format_id: string;
      format_code: string;
      rail: string;
      file_extension: string;
      content_type: string;
      formatter_script: string | null;
    }
  >(
    sql`
    select r.*, p.name as profile_name, p.settings as profile_settings,
           p.originator_secrets_encrypted, f.id as format_id, f.code as format_code,
           f.rail, f.file_extension, f.content_type, f.formatter_script
      from payment_runs r
      join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id and p.is_active
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id and f.is_active
     where r.id = ${runId} and r.org_id = ${orgId}
  `,
    "objects",
  );
  const row = rows[0];
  if (!row) throw new PaymentError("payment run has no active bank profile and format");
  const payments = await db.execute<{
    id: string;
    amount: string;
    currency: string;
    payee_party_id: string;
    display_name: string;
    routing: Record<string, string>;
    account_number_encrypted: string | null;
    reference: string;
    mandate_reference: string | null;
  }>(
    sql`
    select i.id, i.amount, i.currency, i.payee_party_id, p.display_name,
           b.routing, b.account_number_encrypted,
           coalesce(i.payment_reference, d.document_number, i.id::text) as reference,
           m.mandate_reference
      from payment_instructions i
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
      left join party_bank_accounts b on b.id = i.payee_bank_account_id and b.org_id = i.org_id
        and b.is_active and b.approved_at is not null
      left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
      left join payment_mandates m on m.id = i.mandate_id and m.org_id = i.org_id and m.status = 'active'
     where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
     order by p.display_name, i.id
  `,
    "objects",
  );
  return {
    run: row,
    businessDate: await businessToday(orgId),
    profile: {
      id: row.payment_bank_profile_id,
      name: row.profile_name,
      settings: row.profile_settings ?? {},
      secrets:
        row.originator_secrets_encrypted == null
          ? {}
          : unsealJson<Record<string, unknown>>(row.originator_secrets_encrypted, {
              orgId,
              purpose: "payment.originator.secrets",
            }),
    },
    format: {
      id: row.format_id,
      code: row.format_code,
      rail: row.rail,
      extension: row.file_extension,
      contentType: row.content_type,
      formatterScript: row.formatter_script,
    },
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      partyId: p.payee_party_id,
      partyName: p.display_name,
      accountNumber: p.account_number_encrypted
        ? decryptAccountNumber(p.account_number_encrypted, { orgId })
        : "",
      routing: p.routing ?? {},
      reference: p.reference,
      mandateReference: p.mandate_reference,
    })),
  };
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render a register an operator opens in a spreadsheet. Payee names and
 * references are user-authored, so every text cell passes the shared
 * formula-injection guard: a payee named `=HYPERLINK(...)` must never reach
 * a spreadsheet as a live formula. Positive Pay files are not rendered here:
 * they are bank input whose payee text is compared with the presented
 * cheque, so they carry the payee exactly as issued.
 */
export function spreadsheetRegisterCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return (
    rows
      .map((r) => r.map((cell) => csvCell(guardCsvCell(String(cell ?? "")))).join(","))
      .join("\r\n") + "\r\n"
  );
}

function bankCents(amount: string): bigint {
  const units = toUnits(amount);
  if (units <= 0n) throw new PaymentError("bank-file amounts must be positive");
  if (units % 100n !== 0n)
    throw new PaymentError(`bank-file amount ${amount} has a fraction smaller than one cent`);
  return units / 100n;
}

function bankAmount2(amount: string): string {
  const cents = bankCents(amount);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function genericRegister(ctx: FormatContext): {
  filename: string;
  content: string;
  contentType: string;
} {
  const header = ["reference", "counterparty", "amount", "currency", "routing", "account"];
  const rows = ctx.payments.map((p) => [
    p.reference,
    p.partyName,
    p.amount,
    p.currency,
    JSON.stringify(p.routing),
    p.accountNumber,
  ]);
  const runNumber = String(ctx.run.run_number);
  return {
    filename: `${ctx.format.code}-${runNumber}.${ctx.format.extension}`,
    content: spreadsheetRegisterCsv([header, ...rows]),
    contentType: ctx.format.contentType,
  };
}

function chequeRegister(ctx: FormatContext): {
  filename: string;
  content: string;
  contentType: string;
} {
  const header = ["payment_reference", "payee", "amount", "currency", "payment_date"];
  const paymentDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const rows = ctx.payments.map((p) => [
    p.reference,
    p.partyName,
    p.amount,
    p.currency,
    paymentDate,
  ]);
  return {
    filename: `CHEQUE-${String(ctx.run.run_number)}.${ctx.format.extension}`,
    content: spreadsheetRegisterCsv([header, ...rows]),
    contentType: ctx.format.contentType,
  };
}

function positivePayRegister(ctx: FormatContext): {
  filename: string;
  content: string;
  contentType: string;
} {
  const header = [
    "account",
    "issue_date",
    "payment_reference",
    "payee",
    "amount",
    "currency",
    "action",
  ];
  const issueDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const fundingAccount = String(ctx.profile.settings.positivePayAccountReference ?? "");
  if (!fundingAccount)
    throw new PaymentError("Positive Pay profile is missing its bank account reference");
  const rows = ctx.payments.map((p) => [
    fundingAccount,
    issueDate,
    p.reference,
    p.partyName,
    p.amount,
    p.currency,
    "issue",
  ]);
  return {
    filename: `POSITIVE-PAY-${String(ctx.run.run_number)}.${ctx.format.extension}`,
    content: [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n",
    contentType: ctx.format.contentType,
  };
}

/**
 * Parse a debit profile's unsealed `secrets` blob into NACHA originator
 * settings.
 *
 * `secrets` is decrypted tenant JSON, so nothing in it is known to be a string
 * until it has been shown to be one. The credit rails put every originator
 * through `validateNachaSettings`, which additionally rejects an unfinished
 * "FILL-ME" placeholder and an `odfiRouting` that is not exactly nine digits.
 * The debit rail used to assert the blob straight into `NachaSettings` and only
 * check each field for non-emptiness, which let two malformed profiles reach
 * the bank: a placeholder passed through verbatim, and — because the writer
 * below slices `odfiRouting` to eight characters for the batch and file
 * trailers — an over-long routing number truncated into a well-formed
 * 94-character file addressed to the WRONG originating institution.
 */
export function nachaOriginator(secrets: Record<string, unknown>): NachaSettings {
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(secrets)) {
    trimmed[key] = typeof value === "string" ? value.trim() : value;
  }
  const result = validateNachaSettings(trimmed as Partial<NachaSettings>);
  if (!result.ok) {
    if (result.missing.some((item) => item.includes("9 digits"))) {
      throw new PaymentError("NACHA debit profile needs a 9-digit odfiRouting");
    }
    throw new PaymentError(`NACHA debit profile is missing: ${result.missing.join(", ")}`);
  }
  // An unrecognised SEC code would be truncated into the 3-character field as
  // whatever the tenant typed; fall back to the corporate default instead.
  const entryClassCode = trimmed.entryClassCode;
  const entryDescription = trimmed.entryDescription;
  return {
    ...result.settings,
    entryClassCode:
      entryClassCode === "PPD" || entryClassCode === "CCD" ? entryClassCode : undefined,
    entryDescription: typeof entryDescription === "string" ? entryDescription : undefined,
  };
}

/** Render a NACHA debit (collection) file. Exported for its record-width tests. */
export function nachaDebit(
  ctx: FormatContext,
  now: Date,
  fileIdModifier?: string,
): { filename: string; content: string; contentType: string } {
  const s = nachaOriginator(ctx.profile.secrets);
  // Every debit file used to carry a hardcoded "A": two debit runs generated
  // the same day shared the bank's same-day identity and the second drew a
  // duplicate-file rejection. The modifier allocates per run like the credit
  // rail (or arrives allocated from generation).
  const modifier = fileIdModifier ?? nachaFileIdModifierForRunNumber(String(ctx.run.run_number));
  if (!/^[A-Z0-9]$/.test(modifier)) {
    throw new PaymentError(
      "NACHA file requires an allocated file ID modifier (single character A–Z, 0–9)",
    );
  }
  const field = (v: unknown, n: number, right = false, pad = " ") =>
    right
      ? String(v ?? "")
          .slice(0, n)
          .padStart(n, pad)
      : String(v ?? "")
          .slice(0, n)
          .padEnd(n, pad);
  const yymmdd = (d: Date) =>
    `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const odfi8 = s.odfiRouting.slice(0, 8);
  // Fixed-width fields count characters, so every text field is folded to
  // ASCII first: an accented name would otherwise be one byte longer than
  // its field and shift every field after it.
  const originatorText = (value: string | undefined, label: string) =>
    value === undefined ? undefined : asciiRailText(value, "NACHA", label, ORIGINATOR_REMEDY);
  const created = new Date(String(ctx.businessDate) + "T00:00:00Z");
  const effective = new Date(String(ctx.run.scheduled_for ?? ctx.businessDate) + "T00:00:00Z");
  const lines = [
    "1" +
      "01" +
      field(s.immediateDestination, 10, true) +
      field(s.immediateOrigin, 10, true) +
      yymmdd(created) +
      hhmm(now) +
      modifier +
      "094" +
      "10" +
      "1" +
      field(originatorText(s.destinationName, "destination name"), 23) +
      field(originatorText(s.originName, "origin name"), 23) +
      field("", 8),
    "5" +
      "225" +
      field(originatorText(s.companyName, "company name"), 16) +
      field("", 20) +
      field(s.companyId, 10) +
      field(s.entryClassCode ?? "CCD", 3) +
      field(originatorText(s.entryDescription, "entry description") ?? "COLLECT", 10) +
      field("", 6) +
      yymmdd(effective) +
      field("", 3) +
      "1" +
      odfi8 +
      "0000001",
  ];
  let hash = 0n;
  let total = 0n;
  ctx.payments.forEach((p, i) => {
    if (!p.mandateReference) throw new PaymentError(`${p.partyName} has no active debit mandate`);
    const routing = p.routing.aba ?? p.routing.routingNumber ?? "";
    if (!/^\d{9}$/.test(routing))
      throw new PaymentError(`${p.partyName} needs a 9-digit routing number`);
    const cents = bankCents(p.amount);
    hash += BigInt(routing.slice(0, 8));
    total += cents;
    const txn = p.routing.accountType === "savings" ? "37" : "27";
    lines.push(
      "6" +
        txn +
        routing +
        field(p.accountNumber, 17) +
        field(cents, 10, true, "0") +
        field(p.mandateReference, 15) +
        field(asciiRailText(p.partyName, "NACHA", "individual name", PAYEE_NAME_REMEDY), 22) +
        field("", 2) +
        "0" +
        odfi8 +
        field(i + 1, 7, true, "0"),
    );
  });
  const hashText = String(hash % 10_000_000_000n).padStart(10, "0");
  lines.push(
    "8" +
      "225" +
      field(ctx.payments.length, 6, true, "0") +
      hashText +
      field(total, 12, true, "0") +
      field("0", 12, true, "0") +
      field(s.companyId, 10) +
      field("", 19) +
      field("", 6) +
      odfi8 +
      "0000001",
  );
  const blockCount = Math.ceil((lines.length + 1) / 10);
  lines.push(
    "9" +
      field("1", 6, true, "0") +
      field(blockCount, 6, true, "0") +
      field(ctx.payments.length, 8, true, "0") +
      hashText +
      field(total, 12, true, "0") +
      field("0", 12, true, "0") +
      field("", 39),
  );
  while (lines.length % 10) lines.push("9".repeat(94));
  if (lines.some((line) => line.length !== 94))
    throw new PaymentError("generated NACHA debit file failed its 94-character record check");
  return {
    filename: `NACHA-DEBIT-${String(ctx.run.run_number)}.ach`,
    content: lines.join("\n") + "\n",
    contentType: ctx.format.contentType,
  };
}

const SEPA_DEBIT_REQUIRED = [
  "originatorName",
  "originatorIban",
  "originatorBic",
  "creditorId",
] as const;

/**
 * Parse a debit profile's unsealed `secrets` blob into SEPA originator settings
 * plus the creditor scheme identifier the direct-debit mandate needs. Same
 * reasoning as `nachaOriginator`: decrypted tenant JSON is untrusted, and an
 * unfinished "FILL-ME" placeholder must not reach a collection file.
 */
export function sepaOriginator(
  secrets: Record<string, unknown>,
): SepaSettings & { creditorId: string } {
  const values: Record<string, string> = {};
  for (const key of SEPA_DEBIT_REQUIRED) {
    const value = secrets[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "" || text.includes("FILL-ME"))
      throw new PaymentError(`SEPA debit profile is missing ${key}`);
    values[key] = text;
  }
  const originator = validateSepaSettings({
    originatorName: values.originatorName,
    originatorIban: values.originatorIban,
    originatorBic: values.originatorBic,
  });
  if (!originator.ok) {
    throw new PaymentError(`SEPA debit profile has invalid: ${originator.missing.join(", ")}`);
  }
  return {
    ...originator.settings,
    creditorId: values.creditorId!,
  };
}

type SepaDebitEvidence = Awaited<ReturnType<typeof lockRunBankEvidence>>;

/**
 * Render the pain.008 file EXCLUSIVELY from the locked bank-evidence snapshot.
 *
 * `evidence` is the approved snapshot `lockRunBankEvidence("sepa", …)`
 * returned: every debtor IBAN/BIC in it was re-validated under the bank-row
 * locks against the same `isValidIban`/`isValidBic` rules readiness reports,
 * and any missing, inactive, unapproved, or revoked revision throws there —
 * before a single byte renders. The unlocked `ctx.payments` routing is never
 * consulted for bank details (its LEFT JOIN silently NULLs unapproved rows);
 * it supplies only the mandate reference, the end-to-end reference, and the
 * payee name. The snapshot's locks are not held through the later artifact
 * transaction — the render below is pure, so a file always carries exactly
 * the approved revision, never a concurrent pending edit.
 */
function sepaDebit(
  ctx: FormatContext,
  evidence: SepaDebitEvidence,
): { filename: string; content: string; contentType: string } {
  const s = sepaOriginator(ctx.profile.secrets);
  const esc = (v: unknown) =>
    String(v ?? "").replace(
      /[<>&'\"]/g,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" })[c]!,
    );
  const byPayment = new Map(ctx.payments.map((p) => [p.id, p]));
  const total = fromUnits(evidence.reduce((n, e) => n + toUnits(e.amount), 0n));
  const total2 = bankAmount2(total);
  const collectionDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const tx = evidence
    .map((e) => {
      const p = byPayment.get(e.id);
      const payee = p?.partyName ?? e.payee;
      if (!p || !p.mandateReference) throw new PaymentError(`${payee} has no active debit mandate`);
      // Same validity rules the shared evidence control enforced under lock —
      // re-asserted here so the renderer can never emit what readiness blocks.
      const iban = (e.detail.iban ?? "").replace(/\s/g, "").toUpperCase();
      if (!isValidIban(iban)) {
        throw new PaymentError(
          `debtor IBAN for ${payee} is invalid — correct the approved bank account details and re-approve them before generating`,
        );
      }
      const bic = (e.detail.bic ?? "").trim().toUpperCase();
      if (bic !== "" && !isValidBic(bic)) {
        throw new PaymentError(
          `debtor BIC for ${payee} is invalid — correct the approved bank account details and re-approve them before generating`,
        );
      }
      return `      <DrctDbtTxInf><PmtId><EndToEndId>${esc(p.reference)}</EndToEndId></PmtId><InstdAmt Ccy="EUR">${bankAmount2(e.amount)}</InstdAmt><DrctDbtTx><MndtRltdInf><MndtId>${esc(p.mandateReference)}</MndtId></MndtRltdInf><CdtrSchmeId><Id><PrvtId><Othr><Id>${esc(s.creditorId)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId></DrctDbtTx><Dbtr><Nm>${esc(payee)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${esc(iban)}</IBAN></Id></DbtrAcct><RmtInf><Ustrd>${esc(p.reference)}</Ustrd></RmtInf></DrctDbtTxInf>`;
    })
    .join("\n");
  const message = `DD-${String(ctx.run.run_number)}`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02"><CstmrDrctDbtInitn><GrpHdr><MsgId>${esc(message)}</MsgId><CreDtTm>${String(ctx.businessDate)}T00:00:00</CreDtTm><NbOfTxs>${evidence.length}</NbOfTxs><CtrlSum>${total2}</CtrlSum><InitgPty><Nm>${esc(s.originatorName)}</Nm></InitgPty></GrpHdr><PmtInf><PmtInfId>${esc(message)}</PmtInfId><PmtMtd>DD</PmtMtd><NbOfTxs>${evidence.length}</NbOfTxs><CtrlSum>${total2}</CtrlSum><PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf><ReqdColltnDt>${collectionDate}</ReqdColltnDt><Cdtr><Nm>${esc(s.originatorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(s.originatorIban)}</IBAN></Id></CdtrAcct><CdtrAgt><FinInstnId><BIC>${esc(s.originatorBic)}</BIC></FinInstnId></CdtrAgt><ChrgBr>SLEV</ChrgBr>\n${tx}\n</PmtInf></CstmrDrctDbtInitn></Document>\n`;
  return {
    filename: `SEPA-DEBIT-${String(ctx.run.run_number)}.xml`,
    content,
    contentType: ctx.format.contentType,
  };
}

export async function renderPaymentFile(
  ctx: FormatContext,
  orgId: string,
  now: Date,
  fileOpts?: RunFileOptions,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  // The org's calendar day backs every formatter's "no scheduled date" default,
  // so bank files never inherit the server's UTC day by accident.
  const scoped: FormatContext = { ...ctx, businessDate: await businessToday(orgId) };
  if (
    ["rbc_std152_credit", "cpa005_credit", "nacha_credit", "sepa_credit"].includes(
      scoped.format.rail,
    )
  ) {
    return loadRunFile(String(scoped.run.id), orgId, { ...fileOpts, allowedSubsidiaryIds });
  }
  // Every other rail renders from pre-read payment rows instead of locked
  // bank evidence: hold the payee party rows and fail a caller outside any
  // payee's scope before a byte renders, uniformly with the evidence rails.
  await assertPaymentPartiesInScope(
    orgId,
    scoped.payments.map((p) => p.partyId),
    allowedSubsidiaryIds,
  );
  if (scoped.format.rail === "nacha_debit") {
    return {
      ...nachaDebit(scoped, now, fileOpts?.fileIdModifier),
      runNumber: String(scoped.run.run_number),
    };
  }
  if (scoped.format.rail === "sepa_debit") {
    // Same locked-evidence mechanism as the credit writers: debtor bank
    // details are resolved from rows that were approved and active under
    // bank-row locks, or generation fails before anything renders — never a
    // partial file, never a stored artifact, never a status flip. The locks
    // are released when the evidence transaction commits; the render is pure
    // and the artifact transaction below re-judges the run lifecycle.
    const evidence = await lockRunBankEvidence(
      "sepa",
      String(scoped.run.id),
      orgId,
      allowedSubsidiaryIds,
    );
    return { ...sepaDebit(scoped, evidence), runNumber: String(scoped.run.run_number) };
  }
  if (scoped.format.rail === "cheque")
    return { ...chequeRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail === "positive_pay")
    return { ...positivePayRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail !== "custom")
    return { ...genericRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (!scoped.format.formatterScript)
    throw new PaymentError("custom payment format has no formatter script");
  const org = await db.execute<{ id: string; name: string; base_currency: string }>(
    sql`select id, name, base_currency from orgs where id = ${orgId}`,
    "objects",
  );
  const outcome = await runScript(
    scoped.format.formatterScript,
    {
      trigger: "payment_format",
      request: {
        run: scoped.run,
        profile: scoped.profile,
        payments: scoped.payments,
        now: now.toISOString(),
      },
      org: { id: orgId, name: org[0]?.name ?? "", baseCurrency: org[0]?.base_currency ?? "" },
    },
    10_000,
  );
  if (outcome.status !== "ok")
    throw new PaymentError(
      `custom payment format ${outcome.status}: ${outcome.abortReason ?? "no output"}`,
    );
  const out = outcome.returned as {
    filename?: unknown;
    content?: unknown;
    contentType?: unknown;
  } | null;
  if (!out || typeof out.filename !== "string" || typeof out.content !== "string") {
    throw new PaymentError("custom formatter must return { filename, content, contentType? }");
  }
  return {
    filename: out.filename,
    content: out.content,
    contentType: typeof out.contentType === "string" ? out.contentType : scoped.format.contentType,
    runNumber: String(scoped.run.run_number),
  };
}
