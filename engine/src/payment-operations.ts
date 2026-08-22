import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withBypassContext, withOrgContext } from "./db.ts";
import { fromUnits, sum, toUnits } from "./money.ts";
import { businessToday } from "./business-date.ts";
import {
  PaymentError,
  decryptAccountNumber,
  loadRunFile,
  reversePaymentForReturn,
  validateNachaSettings,
  type NachaSettings,
  type SepaSettings,
} from "./payments.ts";
import { computeNextRunAt, runScript } from "./scripting.ts";
import { sealJson, unsealJson } from "./secrets.ts";
import { createPaymentRun } from "./payments.ts";

export type BuiltInPaymentRail =
  | "cpa005_credit"
  | "nacha_credit"
  | "sepa_credit"
  | "nacha_debit"
  | "sepa_debit"
  | "positive_pay"
  | "wire"
  | "cheque";

const BUILTIN_FORMATS: Array<{
  code: string;
  name: string;
  rail: BuiltInPaymentRail;
  direction: "credit" | "debit";
  country: string | null;
  currency: string | null;
  extension: string;
  contentType: string;
}> = [
  { code: "CPA005", name: "CPA Standard 005 credit", rail: "cpa005_credit", direction: "credit", country: "CA", currency: "CAD", extension: "txt", contentType: "text/plain; charset=us-ascii" },
  { code: "NACHA-CREDIT", name: "NACHA ACH credit", rail: "nacha_credit", direction: "credit", country: "US", currency: "USD", extension: "ach", contentType: "text/plain; charset=us-ascii" },
  { code: "SEPA-CREDIT", name: "SEPA credit transfer", rail: "sepa_credit", direction: "credit", country: null, currency: "EUR", extension: "xml", contentType: "application/xml" },
  { code: "NACHA-DEBIT", name: "NACHA ACH debit", rail: "nacha_debit", direction: "debit", country: "US", currency: "USD", extension: "ach", contentType: "text/plain; charset=us-ascii" },
  { code: "SEPA-DEBIT", name: "SEPA direct debit", rail: "sepa_debit", direction: "debit", country: null, currency: "EUR", extension: "xml", contentType: "application/xml" },
  { code: "POSITIVE-PAY", name: "Positive Pay", rail: "positive_pay", direction: "credit", country: null, currency: null, extension: "csv", contentType: "text/csv; charset=utf-8" },
  { code: "WIRE", name: "Wire instruction", rail: "wire", direction: "credit", country: null, currency: null, extension: "csv", contentType: "text/csv; charset=utf-8" },
  { code: "CHEQUE", name: "Cheque register", rail: "cheque", direction: "credit", country: null, currency: null, extension: "csv", contentType: "text/csv; charset=utf-8" },
];

/** Idempotently installs the audited built-in format definitions for one tenant. */
export async function ensureBuiltInPaymentFormats(
  orgId: string,
  userId: string | null = null,
): Promise<void> {
  for (const f of BUILTIN_FORMATS) {
    await db.execute(sql`
      insert into payment_formats
        (org_id, code, name, rail, direction, country, currency, file_extension, content_type, created_by, updated_by)
      values
        (${orgId}, ${f.code}, ${f.name}, ${f.rail}, ${f.direction}, ${f.country}, ${f.currency}, ${f.extension}, ${f.contentType}, ${userId}, ${userId})
      on conflict (org_id, code) do update set
        name = excluded.name, rail = excluded.rail, direction = excluded.direction,
        country = excluded.country, currency = excluded.currency,
        file_extension = excluded.file_extension, content_type = excluded.content_type,
        updated_at = now(), updated_by = excluded.updated_by
    `);
  }
}

export interface PaymentBankProfileInput {
  name: string;
  bankAccountId: string;
  subsidiaryId?: string | null;
  paymentFormatId: string;
  currency: string;
  country?: string | null;
  originatorSecrets?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  sftpServerId?: string | null;
  sftpFolder?: string | null;
  requireRunApproval?: boolean;
  requireFileApproval?: boolean;
  autoRemittance?: boolean;
  isActive?: boolean;
}

async function validatePaymentBankProfileRefs(orgId: string, input: {
  bankAccountId: string;
  paymentFormatId: string;
  subsidiaryId?: string | null;
  sftpServerId?: string | null;
  currency: string;
  settings?: Record<string, unknown>;
}): Promise<void> {
  const result = (await db.execute<{ format_currency: string | null; rail: string }>(sql`
    select f.currency as format_currency, f.rail
      from payment_formats f
      join accounts a on a.id = ${input.bankAccountId} and a.org_id = f.org_id
                         and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where f.id = ${input.paymentFormatId} and f.org_id = ${orgId} and f.is_active
       and (${input.subsidiaryId ?? null}::uuid is null or exists (
         select 1 from subsidiaries s where s.id = ${input.subsidiaryId ?? null} and s.org_id = ${orgId} and s.is_active))
       and (${input.sftpServerId ?? null}::uuid is null or exists (
         select 1 from sftp_servers sv where sv.id = ${input.sftpServerId ?? null} and sv.org_id = ${orgId} and sv.is_active))
  `));
  const row = result.rows[0];
  if (!row) throw new PaymentError("select active tenant-owned payment, bank, subsidiary, and delivery records");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new PaymentError("currency must be a three-letter ISO code");
  if (row.format_currency && row.format_currency !== input.currency) {
    throw new PaymentError(`the selected format requires ${row.format_currency}`);
  }
  const discountAccountId = input.settings?.discountAccountId;
  if (typeof discountAccountId === "string" && discountAccountId) {
    const account = (await db.execute<{ id: string }>(sql`
      select id from accounts where id = ${discountAccountId} and org_id = ${orgId} and is_active and not is_summary
    `));
    if (!account.rows[0]) throw new PaymentError("discount account is invalid or inactive");
  }
  if (row.rail === "positive_pay" && !String(input.settings?.positivePayAccountReference ?? "").trim()) {
    throw new PaymentError("Positive Pay requires the institution's bank account reference");
  }
}

/** Creates a profile without ever persisting plaintext originator credentials. */
export async function createPaymentBankProfile(
  orgId: string,
  userId: string,
  input: PaymentBankProfileInput,
): Promise<{ id: string }> {
  await validatePaymentBankProfileRefs(orgId, input);
  const [profile] = await db.insert(schema.paymentBankProfiles).values({
    orgId,
    name: input.name.trim(),
    bankAccountId: input.bankAccountId,
    subsidiaryId: input.subsidiaryId ?? null,
    paymentFormatId: input.paymentFormatId,
    currency: input.currency,
    country: input.country ?? null,
    originatorSecretsEncrypted: input.originatorSecrets ? sealJson(input.originatorSecrets) : null,
    settings: input.settings ?? {},
    sftpServerId: input.sftpServerId ?? null,
    sftpFolder: input.sftpFolder ?? null,
    requireRunApproval: input.requireRunApproval ?? true,
    requireFileApproval: input.requireFileApproval ?? false,
    autoRemittance: input.autoRemittance ?? false,
    isActive: input.isActive ?? true,
    createdBy: userId,
    updatedBy: userId,
  }).returning({ id: schema.paymentBankProfiles.id });
  return profile;
}

export async function updatePaymentBankProfile(
  id: string,
  orgId: string,
  userId: string,
  input: Partial<PaymentBankProfileInput>,
): Promise<void> {
  const existing = (await db.execute<{ id: string; originator_secrets_encrypted: string | null; bank_account_id: string; subsidiary_id: string | null; payment_format_id: string; currency: string; settings: Record<string, unknown>; sftp_server_id: string | null }>(sql`
    select * from payment_bank_profiles where id = ${id} and org_id = ${orgId}
  `));
  if (!existing.rows[0]) throw new PaymentError("payment bank profile not found");
  const current = existing.rows[0];
  await validatePaymentBankProfileRefs(orgId, {
    bankAccountId: input.bankAccountId ?? current.bank_account_id,
    subsidiaryId: input.subsidiaryId === undefined ? current.subsidiary_id : input.subsidiaryId,
    paymentFormatId: input.paymentFormatId ?? current.payment_format_id,
    currency: input.currency ?? current.currency,
    settings: input.settings ?? current.settings,
    sftpServerId: input.sftpServerId === undefined ? current.sftp_server_id : input.sftpServerId,
  });
  const secret = input.originatorSecrets === undefined
    ? current.originator_secrets_encrypted
    : input.originatorSecrets === null
      ? null
      : sealJson({
          ...(unsealJson<Record<string, unknown>>(current.originator_secrets_encrypted) ?? {}),
          ...input.originatorSecrets,
        });
  await db.execute(sql`
    update payment_bank_profiles set
      name = coalesce(${input.name?.trim() ?? null}, name),
      bank_account_id = coalesce(${input.bankAccountId ?? null}::uuid, bank_account_id),
      subsidiary_id = case when ${input.subsidiaryId === undefined} then subsidiary_id else ${input.subsidiaryId ?? null}::uuid end,
      payment_format_id = coalesce(${input.paymentFormatId ?? null}::uuid, payment_format_id),
      currency = coalesce(${input.currency ?? null}, currency),
      country = case when ${input.country === undefined} then country else ${input.country ?? null} end,
      originator_secrets_encrypted = ${secret},
      settings = coalesce(${input.settings ? JSON.stringify(input.settings) : null}::jsonb, settings),
      sftp_server_id = case when ${input.sftpServerId === undefined} then sftp_server_id else ${input.sftpServerId ?? null}::uuid end,
      sftp_folder = case when ${input.sftpFolder === undefined} then sftp_folder else ${input.sftpFolder ?? null} end,
      require_run_approval = coalesce(${input.requireRunApproval ?? null}, require_run_approval),
      require_file_approval = coalesce(${input.requireFileApproval ?? null}, require_file_approval),
      auto_remittance = coalesce(${input.autoRemittance ?? null}, auto_remittance),
      is_active = coalesce(${input.isActive ?? null}, is_active),
      updated_at = now(), updated_by = ${userId}
    where id = ${id} and org_id = ${orgId}
  `);
}

async function event(opts: {
  orgId: string;
  runId: string;
  eventType: string;
  actorId?: string | null;
  instructionId?: string | null;
  fileId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.paymentEvents).values({
    orgId: opts.orgId,
    paymentRunId: opts.runId,
    paymentInstructionId: opts.instructionId ?? null,
    paymentFileId: opts.fileId ?? null,
    eventType: opts.eventType,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus ?? null,
    details: opts.details ?? {},
    actorId: opts.actorId ?? null,
  });
}

export async function submitPaymentRun(runId: string, orgId: string, userId: string): Promise<void> {
  const result = (await db.execute<{ status: string }>(sql`
    update payment_runs r set
      status = case when p.require_run_approval then 'pending_approval' else 'approved' end,
      submitted_at = now(), submitted_by = ${userId},
      approved_at = case when p.require_run_approval then null else now() end,
      approved_by = case when p.require_run_approval then null else ${userId} end,
      updated_at = now(), updated_by = ${userId}
    from payment_bank_profiles p
    where r.id = ${runId} and r.org_id = ${orgId} and r.status = 'draft'
      and p.id = r.payment_bank_profile_id and p.is_active and r.payment_count > 0 and r.total_amount > 0
    returning r.status
  `));
  const row = result.rows[0];
  if (!row) throw new PaymentError("only a non-empty draft run with an active profile can be submitted");
  await event({ orgId, runId, eventType: "run_submitted", actorId: userId, fromStatus: "draft", toStatus: row.status });
}

export async function decidePaymentRun(
  runId: string,
  orgId: string,
  userId: string,
  decision: "approve" | "reject",
  reason?: string | null,
): Promise<void> {
  if (decision === "reject" && !reason?.trim()) throw new PaymentError("a rejection reason is required");
  const next = decision === "approve" ? "approved" : "rejected";
  const result = (await db.execute<{ id: string }>(sql`
    update payment_runs set
      status = ${next},
      approved_at = case when ${decision} = 'approve' then now() else null end,
      approved_by = case when ${decision} = 'approve' then ${userId} else null end,
      rejected_at = case when ${decision} = 'reject' then now() else null end,
      rejected_by = case when ${decision} = 'reject' then ${userId} else null end,
      rejection_reason = case when ${decision} = 'reject' then ${reason?.trim() ?? null} else null end,
      updated_at = now(), updated_by = ${userId}
    where id = ${runId} and org_id = ${orgId} and status = 'pending_approval'
    returning id
  `));
  if (!result.rows[0]) throw new PaymentError("only a run pending approval can be decided");
  await event({ orgId, runId, eventType: `run_${decision}d`, actorId: userId, fromStatus: "pending_approval", toStatus: next, details: reason ? { reason } : {} });
}

interface FormatContext {
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

async function loadFormatContext(runId: string, orgId: string): Promise<FormatContext> {
  const rows = (await db.execute<Record<string, unknown> & {
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
  }>(sql`
    select r.*, p.name as profile_name, p.settings as profile_settings,
           p.originator_secrets_encrypted, f.id as format_id, f.code as format_code,
           f.rail, f.file_extension, f.content_type, f.formatter_script
      from payment_runs r
      join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id and p.is_active
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id and f.is_active
     where r.id = ${runId} and r.org_id = ${orgId}
  `));
  const row = rows.rows[0];
  if (!row) throw new PaymentError("payment run has no active bank profile and format");
  const payments = (await db.execute<{
    id: string;
    amount: string;
    currency: string;
    payee_party_id: string;
    display_name: string;
    routing: Record<string, string>;
    account_number_encrypted: string | null;
    reference: string;
    mandate_reference: string | null;
  }>(sql`
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
  `));
  return {
    run: row,
    businessDate: await businessToday(orgId),
    profile: {
      id: row.payment_bank_profile_id,
      name: row.profile_name,
      settings: row.profile_settings ?? {},
      secrets: unsealJson<Record<string, unknown>>(row.originator_secrets_encrypted) ?? {},
    },
    format: {
      id: row.format_id,
      code: row.format_code,
      rail: row.rail,
      extension: row.file_extension,
      contentType: row.content_type,
      formatterScript: row.formatter_script,
    },
    payments: payments.rows.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      partyId: p.payee_party_id,
      partyName: p.display_name,
      accountNumber: p.account_number_encrypted ? decryptAccountNumber(p.account_number_encrypted) : "",
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

function bankCents(amount: string): bigint {
  const units = toUnits(amount);
  if (units <= 0n) throw new PaymentError("bank-file amounts must be positive");
  if (units % 100n !== 0n) throw new PaymentError(`bank-file amount ${amount} has a fraction smaller than one cent`);
  return units / 100n;
}

function bankAmount2(amount: string): string {
  const cents = bankCents(amount);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function genericRegister(ctx: FormatContext): { filename: string; content: string; contentType: string } {
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
    content: [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n",
    contentType: ctx.format.contentType,
  };
}

function chequeRegister(ctx: FormatContext): { filename: string; content: string; contentType: string } {
  const header = ["payment_reference", "payee", "amount", "currency", "payment_date"];
  const paymentDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const rows = ctx.payments.map((p) => [p.reference, p.partyName, p.amount, p.currency, paymentDate]);
  return {
    filename: `CHEQUE-${String(ctx.run.run_number)}.${ctx.format.extension}`,
    content: [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n",
    contentType: ctx.format.contentType,
  };
}

function positivePayRegister(ctx: FormatContext): { filename: string; content: string; contentType: string } {
  const header = ["account", "issue_date", "payment_reference", "payee", "amount", "currency", "action"];
  const issueDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const fundingAccount = String(ctx.profile.settings.positivePayAccountReference ?? "");
  if (!fundingAccount) throw new PaymentError("Positive Pay profile is missing its bank account reference");
  const rows = ctx.payments.map((p) => [fundingAccount, issueDate, p.reference, p.partyName, p.amount, p.currency, "issue"]);
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
    entryClassCode: entryClassCode === "PPD" || entryClassCode === "CCD" ? entryClassCode : undefined,
    entryDescription: typeof entryDescription === "string" ? entryDescription : undefined,
  };
}

function nachaDebit(ctx: FormatContext, now: Date): { filename: string; content: string; contentType: string } {
  const s = nachaOriginator(ctx.profile.secrets);
  const field = (v: unknown, n: number, right = false, pad = " ") => (right ? String(v ?? "").slice(0, n).padStart(n, pad) : String(v ?? "").slice(0, n).padEnd(n, pad));
  const yymmdd = (d: Date) => `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const odfi8 = s.odfiRouting.slice(0, 8);
  const effective = new Date(String(ctx.run.scheduled_for ?? ctx.businessDate) + "T00:00:00Z");
  const lines = [
    "1" + "01" + field(s.immediateDestination, 10, true) + field(s.immediateOrigin, 10, true) + yymmdd(now) + hhmm(now) + "A094101" + field(s.destinationName, 23) + field(s.originName, 23) + field("", 8),
    "5" + "225" + field(s.companyName, 16) + field("", 20) + field(s.companyId, 10) + field(s.entryClassCode ?? "CCD", 3) + field(s.entryDescription ?? "COLLECT", 10) + field("", 6) + yymmdd(effective) + field("", 3) + "1" + odfi8 + "0000001",
  ];
  let hash = 0n;
  let total = 0n;
  ctx.payments.forEach((p, i) => {
    if (!p.mandateReference) throw new PaymentError(`${p.partyName} has no active debit mandate`);
    const routing = p.routing.aba ?? p.routing.routingNumber ?? "";
    if (!/^\d{9}$/.test(routing)) throw new PaymentError(`${p.partyName} needs a 9-digit routing number`);
    const cents = bankCents(p.amount);
    hash += BigInt(routing.slice(0, 8));
    total += cents;
    const txn = p.routing.accountType === "savings" ? "37" : "27";
    lines.push("6" + txn + routing + field(p.accountNumber, 17) + field(cents, 10, true, "0") + field(p.mandateReference, 15) + field(p.partyName, 22) + field("", 2) + "0" + odfi8 + field(i + 1, 7, true, "0"));
  });
  const hashText = String(hash % 10_000_000_000n).padStart(10, "0");
  lines.push("8" + "225" + field(ctx.payments.length, 6, true, "0") + hashText + field(total, 12, true, "0") + field("0", 12, true, "0") + field(s.companyId, 10) + field("", 19) + field("", 6) + odfi8 + "0000001");
  const blockCount = Math.ceil((lines.length + 1) / 10);
  lines.push("9" + field("1", 6, true, "0") + field(blockCount, 6, true, "0") + field(ctx.payments.length, 8, true, "0") + hashText + field(total, 12, true, "0") + field("0", 12, true, "0") + field("", 39));
  while (lines.length % 10) lines.push("9".repeat(94));
  if (lines.some((line) => line.length !== 94)) throw new PaymentError("generated NACHA debit file failed its 94-character record check");
  return { filename: `NACHA-DEBIT-${String(ctx.run.run_number)}.ach`, content: lines.join("\n") + "\n", contentType: ctx.format.contentType };
}

const SEPA_DEBIT_REQUIRED = ["originatorName", "originatorIban", "originatorBic", "creditorId"] as const;

/**
 * Parse a debit profile's unsealed `secrets` blob into SEPA originator settings
 * plus the creditor scheme identifier the direct-debit mandate needs. Same
 * reasoning as `nachaOriginator`: decrypted tenant JSON is untrusted, and an
 * unfinished "FILL-ME" placeholder must not reach a collection file.
 */
export function sepaOriginator(secrets: Record<string, unknown>): SepaSettings & { creditorId: string } {
  const values: Record<string, string> = {};
  for (const key of SEPA_DEBIT_REQUIRED) {
    const value = secrets[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "" || text.includes("FILL-ME")) throw new PaymentError(`SEPA debit profile is missing ${key}`);
    values[key] = text;
  }
  return {
    originatorName: values.originatorName,
    originatorIban: values.originatorIban,
    originatorBic: values.originatorBic,
    creditorId: values.creditorId,
  };
}

function sepaDebit(ctx: FormatContext, now: Date): { filename: string; content: string; contentType: string } {
  const s = sepaOriginator(ctx.profile.secrets);
  const esc = (v: unknown) => String(v ?? "").replace(/[<>&'\"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" }[c]!));
  const total = fromUnits(ctx.payments.reduce((n, p) => n + toUnits(p.amount), 0n));
  const total2 = bankAmount2(total);
  const collectionDate = String(ctx.run.scheduled_for ?? ctx.businessDate);
  const tx = ctx.payments.map((p) => {
    if (!p.mandateReference) throw new PaymentError(`${p.partyName} has no active debit mandate`);
    const iban = (p.routing.iban ?? p.accountNumber).replace(/\s/g, "");
    return `      <DrctDbtTxInf><PmtId><EndToEndId>${esc(p.reference)}</EndToEndId></PmtId><InstdAmt Ccy="EUR">${bankAmount2(p.amount)}</InstdAmt><DrctDbtTx><MndtRltdInf><MndtId>${esc(p.mandateReference)}</MndtId></MndtRltdInf><CdtrSchmeId><Id><PrvtId><Othr><Id>${esc(s.creditorId)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId></DrctDbtTx><Dbtr><Nm>${esc(p.partyName)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${esc(iban)}</IBAN></Id></DbtrAcct><RmtInf><Ustrd>${esc(p.reference)}</Ustrd></RmtInf></DrctDbtTxInf>`;
  }).join("\n");
  const message = `DD-${String(ctx.run.run_number)}`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02"><CstmrDrctDbtInitn><GrpHdr><MsgId>${esc(message)}</MsgId><CreDtTm>${now.toISOString()}</CreDtTm><NbOfTxs>${ctx.payments.length}</NbOfTxs><CtrlSum>${total2}</CtrlSum><InitgPty><Nm>${esc(s.originatorName)}</Nm></InitgPty></GrpHdr><PmtInf><PmtInfId>${esc(message)}</PmtInfId><PmtMtd>DD</PmtMtd><NbOfTxs>${ctx.payments.length}</NbOfTxs><CtrlSum>${total2}</CtrlSum><PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf><ReqdColltnDt>${collectionDate}</ReqdColltnDt><Cdtr><Nm>${esc(s.originatorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(s.originatorIban)}</IBAN></Id></CdtrAcct><CdtrAgt><FinInstnId><BIC>${esc(s.originatorBic)}</BIC></FinInstnId></CdtrAgt><ChrgBr>SLEV</ChrgBr>\n${tx}\n</PmtInf></CstmrDrctDbtInitn></Document>\n`;
  return { filename: `SEPA-DEBIT-${String(ctx.run.run_number)}.xml`, content, contentType: ctx.format.contentType };
}

async function renderPaymentFile(ctx: FormatContext, orgId: string, now: Date) {
  // The org's calendar day backs every formatter's "no scheduled date" default,
  // so bank files never inherit the server's UTC day by accident.
  const scoped: FormatContext = { ...ctx, businessDate: await businessToday(orgId) };
  if (["cpa005_credit", "nacha_credit", "sepa_credit"].includes(scoped.format.rail)) {
    return loadRunFile(String(scoped.run.id), orgId, now);
  }
  if (scoped.format.rail === "nacha_debit") return { ...nachaDebit(scoped, now), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail === "sepa_debit") return { ...sepaDebit(scoped, now), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail === "cheque") return { ...chequeRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail === "positive_pay") return { ...positivePayRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (scoped.format.rail !== "custom") return { ...genericRegister(scoped), runNumber: String(scoped.run.run_number) };
  if (!scoped.format.formatterScript) throw new PaymentError("custom payment format has no formatter script");
  const org = (await db.execute<{ id: string; name: string; base_currency: string }>(sql`select id, name, base_currency from orgs where id = ${orgId}`));
  const outcome = await runScript(scoped.format.formatterScript, {
    trigger: "payment_format",
    request: { run: scoped.run, profile: scoped.profile, payments: scoped.payments, now: now.toISOString() },
    org: { id: orgId, name: org.rows[0]?.name ?? "", baseCurrency: org.rows[0]?.base_currency ?? "" },
  }, 10_000);
  if (outcome.status !== "ok") throw new PaymentError(`custom payment format ${outcome.status}: ${outcome.abortReason ?? "no output"}`);
  const out = outcome.returned as { filename?: unknown; content?: unknown; contentType?: unknown } | null;
  if (!out || typeof out.filename !== "string" || typeof out.content !== "string") {
    throw new PaymentError("custom formatter must return { filename, content, contentType? }");
  }
  return { filename: out.filename, content: out.content, contentType: typeof out.contentType === "string" ? out.contentType : scoped.format.contentType, runNumber: String(scoped.run.run_number) };
}

async function storeArtifactFile(
  orgId: string,
  userId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  hash: string,
): Promise<{ fileId: string; versionId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-files:${orgId}`}, 0))`);
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and system_kind = 'payment_files' limit 1
    `));
    let folderId = existing.rows[0]?.id;
    if (!folderId) {
      const created = (await tx.execute<{ id: string }>(sql`
        insert into folders (org_id, name, is_system, system_kind, created_by, updated_by)
        values (${orgId}, 'Payment files', true, 'payment_files', ${userId}, ${userId})
        returning id
      `));
      folderId = created.rows[0]?.id;
    }
    if (!folderId) throw new PaymentError("could not create the payment file cabinet folder");
    const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : null;
    const [file] = await tx.insert(schema.files).values({
      orgId,
      folderId,
      name: filename,
      extension,
      fileType: extension === "xml" ? "document" : extension === "csv" ? "csv" : "text",
      contentType,
      sizeBytes: bytes.length,
      contentHash: hash,
      createdBy: userId,
      updatedBy: userId,
    }).returning({ id: schema.files.id });
    const [version] = await tx.insert(schema.fileVersions).values({
      fileId: file.id,
      versionNumber: 1,
      sizeBytes: bytes.length,
      contentType,
      contentHash: hash,
      createdBy: userId,
    }).returning({ id: schema.fileVersions.id });
    await tx.insert(schema.fileBlobs).values({ versionId: version.id, bytes });
    await tx.execute(sql`update files set current_version_id = ${version.id} where id = ${file.id} and org_id = ${orgId}`);
    return { fileId: file.id, versionId: version.id };
  });
}

export async function generatePaymentFileArtifact(
  runId: string,
  orgId: string,
  userId: string,
  opts?: { reprocessFileId?: string | null; now?: Date },
): Promise<{ id: string; filename: string; contentType: string; content: Buffer }> {
  const ctx = await loadFormatContext(runId, orgId);
  const status = String(ctx.run.status);
  if (!["approved", "generated", "delivered", "partially_failed"].includes(status)) {
    throw new PaymentError("approve the payment run before generating its file");
  }
  if (!opts?.reprocessFileId) {
    const existing = (await db.execute<{ id: string; filename: string; content_type: string; bytes: Buffer }>(sql`
      select pf.id, pf.filename, pf.content_type, fb.bytes
        from payment_files pf
        join file_blobs fb on fb.version_id = pf.file_version_id
       where pf.payment_run_id = ${runId} and pf.org_id = ${orgId} and pf.status not in ('superseded', 'voided', 'rejected')
       order by pf.sequence_number desc limit 1
    `));
    if (existing.rows[0]) return { id: existing.rows[0].id, filename: existing.rows[0].filename, contentType: existing.rows[0].content_type, content: existing.rows[0].bytes };
  }
  const now = opts?.now ?? new Date();
  const rendered = await renderPaymentFile(ctx, orgId, now);
  const content = Buffer.from(rendered.content, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const stored = await storeArtifactFile(orgId, userId, rendered.filename, rendered.contentType, content, hash);
  const seq = (await db.execute<{ n: number }>(sql`select coalesce(max(sequence_number), 0) + 1 as n from payment_files where payment_run_id = ${runId} and org_id = ${orgId}`));
  const parentId = opts?.reprocessFileId ?? null;
  const profile = (await db.execute<{ require_file_approval: boolean }>(sql`
    select require_file_approval from payment_bank_profiles where id = ${ctx.profile.id} and org_id = ${orgId}
  `));
  const fileStatus = profile.rows[0]?.require_file_approval ? "pending_approval" : "approved";
  const total = sum(ctx.payments.map((p) => p.amount));
  const [artifact] = await db.insert(schema.paymentFiles).values({
    orgId,
    paymentRunId: runId,
    paymentBankProfileId: ctx.profile.id,
    paymentFormatId: ctx.format.id,
    parentPaymentFileId: parentId,
    sequenceNumber: Number(seq.rows[0]?.n ?? 1),
    filename: rendered.filename,
    contentType: rendered.contentType,
    contentHash: hash,
    fileId: stored.fileId,
    fileVersionId: stored.versionId,
    paymentCount: ctx.payments.length,
    totalAmount: total,
    currency: String(ctx.run.currency),
    status: fileStatus,
    generatedBy: userId,
    approvedAt: fileStatus === "approved" ? now : null,
    approvedBy: fileStatus === "approved" ? userId : null,
    createdBy: userId,
    updatedBy: userId,
  }).returning({ id: schema.paymentFiles.id });
  if (parentId) await db.execute(sql`update payment_files set status = 'superseded', updated_at = now(), updated_by = ${userId} where id = ${parentId} and payment_run_id = ${runId} and org_id = ${orgId}`);
  await db.execute(sql`
    update payment_runs set status = 'generated', exported_at = coalesce(exported_at, now()),
      exported_file_ref = ${rendered.filename}, updated_at = now(), updated_by = ${userId}
    where id = ${runId} and org_id = ${orgId}
  `);
  await event({ orgId, runId, fileId: artifact.id, actorId: userId, eventType: parentId ? "file_reprocessed" : "file_generated", fromStatus: status, toStatus: "generated", details: { hash, filename: rendered.filename } });
  return { id: artifact.id, filename: rendered.filename, contentType: rendered.contentType, content };
}

export async function decidePaymentFile(
  fileId: string,
  orgId: string,
  userId: string,
  decision: "approve" | "reject",
  reason?: string | null,
): Promise<void> {
  if (decision === "reject" && !reason?.trim()) throw new PaymentError("a rejection reason is required");
  const result = (await db.execute<{ payment_run_id: string }>(sql`
    update payment_files set
      status = ${decision === "approve" ? "approved" : "rejected"},
      approved_at = case when ${decision} = 'approve' then now() else null end,
      approved_by = case when ${decision} = 'approve' then ${userId} else null end,
      rejected_at = case when ${decision} = 'reject' then now() else null end,
      rejected_by = case when ${decision} = 'reject' then ${userId} else null end,
      rejection_reason = case when ${decision} = 'reject' then ${reason?.trim() ?? null} else null end,
      updated_at = now(), updated_by = ${userId}
    where id = ${fileId} and org_id = ${orgId} and status = 'pending_approval'
    returning payment_run_id
  `));
  if (!result.rows[0]) throw new PaymentError("only a file pending approval can be decided");
  await event({ orgId, runId: result.rows[0].payment_run_id, fileId, actorId: userId, eventType: `file_${decision}d`, fromStatus: "pending_approval", toStatus: decision === "approve" ? "approved" : "rejected", details: reason ? { reason } : {} });
}

export async function recordPaymentFileDownload(fileId: string, orgId: string, userId: string): Promise<void> {
  const file = (await db.execute<{ payment_run_id: string }>(sql`
    select payment_run_id from payment_files where id = ${fileId} and org_id = ${orgId} and status in ('approved', 'delivered')
  `));
  if (!file.rows[0]) throw new PaymentError("payment file is not approved for delivery");
  await db.insert(schema.paymentFileDeliveries).values({
    orgId,
    paymentFileId: fileId,
    channel: "download",
    targetRef: userId,
    status: "delivered",
    attemptCount: 1,
    lastAttemptAt: new Date(),
    deliveredAt: new Date(),
    createdBy: userId,
    updatedBy: userId,
  });
  await db.execute(sql`update payment_files set status = 'delivered', updated_at = now(), updated_by = ${userId} where id = ${fileId} and org_id = ${orgId}`);
  await db.execute(sql`update payment_runs set status = 'delivered', updated_at = now(), updated_by = ${userId} where id = ${file.rows[0].payment_run_id} and org_id = ${orgId} and status = 'generated'`);
  await event({ orgId, runId: file.rows[0].payment_run_id, fileId, actorId: userId, eventType: "file_downloaded", fromStatus: "approved", toStatus: "delivered" });
}

export async function recordPaymentFileSftpDelivery(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  targetRef: string;
  response?: Record<string, unknown>;
}): Promise<void> {
  const file = (await db.execute<{ payment_run_id: string }>(sql`
    select payment_run_id from payment_files
     where id = ${opts.fileId} and org_id = ${opts.orgId} and status in ('approved', 'delivered')
  `));
  if (!file.rows[0]) throw new PaymentError("payment file is not approved for delivery");
  await db.insert(schema.paymentFileDeliveries).values({
    orgId: opts.orgId,
    paymentFileId: opts.fileId,
    channel: "sftp",
    targetRef: opts.targetRef,
    status: "delivered",
    attemptCount: 1,
    lastAttemptAt: new Date(),
    deliveredAt: new Date(),
    response: opts.response ?? {},
    createdBy: opts.userId,
    updatedBy: opts.userId,
  });
  await db.execute(sql`update payment_files set status = 'delivered', updated_at = now(), updated_by = ${opts.userId} where id = ${opts.fileId} and org_id = ${opts.orgId}`);
  await db.execute(sql`update payment_runs set status = 'delivered', updated_at = now(), updated_by = ${opts.userId} where id = ${file.rows[0].payment_run_id} and org_id = ${opts.orgId} and status = 'generated'`);
  await event({ orgId: opts.orgId, runId: file.rows[0].payment_run_id, fileId: opts.fileId, actorId: opts.userId, eventType: "file_delivered_sftp", fromStatus: "approved", toStatus: "delivered", details: { targetRef: opts.targetRef } });
}

export async function recordPaymentFileDeliveryFailure(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  channel: "sftp" | "bank_api";
  targetRef: string;
  error: string;
}): Promise<void> {
  const file = (await db.execute<{ payment_run_id: string }>(sql`select payment_run_id from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}`));
  if (!file.rows[0]) throw new PaymentError("payment file not found");
  await db.insert(schema.paymentFileDeliveries).values({ orgId: opts.orgId, paymentFileId: opts.fileId, channel: opts.channel, targetRef: opts.targetRef, status: "failed", attemptCount: 1, lastAttemptAt: new Date(), error: opts.error, createdBy: opts.userId, updatedBy: opts.userId });
  await event({ orgId: opts.orgId, runId: file.rows[0].payment_run_id, fileId: opts.fileId, actorId: opts.userId, eventType: "file_delivery_failed", details: { channel: opts.channel, targetRef: opts.targetRef, error: opts.error } });
}

export async function rollbackPaymentRun(runId: string, orgId: string, userId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new PaymentError("a rollback reason is required");
  const result = (await db.execute<{ status: string }>(sql`
    update payment_runs r set status = 'rolled_back', updated_at = now(), updated_by = ${userId}
     where r.id = ${runId} and r.org_id = ${orgId} and r.status in ('approved', 'generated', 'delivered', 'partially_failed')
       and not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status in ('sent', 'settled', 'returned', 'reversed'))
     returning r.status
  `));
  if (!result.rows[0]) throw new PaymentError("a run can only be rolled back before any payment is posted or settled");
  await db.execute(sql`update payment_files set status = 'voided', updated_at = now(), updated_by = ${userId} where payment_run_id = ${runId} and org_id = ${orgId} and status not in ('superseded', 'voided')`);
  await event({ orgId, runId, actorId: userId, eventType: "run_rolled_back", toStatus: "rolled_back", details: { reason } });
}

export async function recordPaymentSettlement(opts: {
  instructionId: string;
  orgId: string;
  userId: string;
  status: "settled" | "returned" | "rejected";
  effectiveOn: string;
  bankReference?: string | null;
  bankStatementLineId?: string | null;
  returnCode?: string | null;
  returnReason?: string | null;
}): Promise<void> {
  const row = (await db.execute<{ payment_run_id: string; payment_document_id: string | null; amount: string; currency: string; status: string }>(sql`
    select i.payment_run_id, i.payment_document_id, i.amount, i.currency, i.status
      from payment_instructions i join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
     where i.id = ${opts.instructionId} and i.org_id = ${opts.orgId}
  `));
  const instruction = row.rows[0];
  if (!instruction) throw new PaymentError("payment instruction not found");
  if (!["sent", "settled", "returned"].includes(instruction.status)) throw new PaymentError("only a sent payment can be settled or returned");
  let reversalEntryId: string | null = null;
  if ((opts.status === "returned" || opts.status === "rejected") && instruction.status !== "returned") {
    if (!instruction.payment_document_id) throw new PaymentError("returned instruction has no payment document");
    reversalEntryId = await reversePaymentForReturn(
      instruction.payment_document_id,
      opts.orgId,
      opts.returnReason ?? opts.returnCode ?? "payment returned by bank",
      opts.userId,
      opts.effectiveOn,
    );
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into payment_settlements
        (org_id, payment_instruction_id, bank_statement_line_id, status, amount, currency,
         effective_on, bank_reference, return_code, return_reason, reversal_entry_id, created_by, updated_by)
      values (${opts.orgId}, ${opts.instructionId}, ${opts.bankStatementLineId ?? null}, ${opts.status},
              ${instruction.amount}, ${instruction.currency}, ${opts.effectiveOn}, ${opts.bankReference ?? null},
              ${opts.returnCode ?? null}, ${opts.returnReason ?? null}, ${reversalEntryId}, ${opts.userId}, ${opts.userId})
      on conflict (payment_instruction_id) do update set
        bank_statement_line_id = excluded.bank_statement_line_id, status = excluded.status,
        effective_on = excluded.effective_on, bank_reference = excluded.bank_reference,
        return_code = excluded.return_code, return_reason = excluded.return_reason,
        reversal_entry_id = coalesce(excluded.reversal_entry_id, payment_settlements.reversal_entry_id),
        updated_at = now(), updated_by = excluded.updated_by
    `);
    await tx.execute(sql`update payment_instructions set status = ${opts.status}, updated_at = now(), updated_by = ${opts.userId} where id = ${opts.instructionId} and org_id = ${opts.orgId}`);
    if (opts.status === "returned") {
      await tx.execute(sql`update payment_run_items set status = 'returned', updated_at = now(), updated_by = ${opts.userId} where payment_instruction_id = ${opts.instructionId} and org_id = ${opts.orgId}`);
    }
    await tx.execute(sql`
      update payment_runs r set
        status = case
          when exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status in ('returned', 'rejected')) then 'returned'
          when not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status not in ('settled', 'cancelled')) then 'settled'
          else r.status end,
        settled_at = case when not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status not in ('settled', 'cancelled')) then now() else settled_at end,
        updated_at = now(), updated_by = ${opts.userId}
      where r.id = ${instruction.payment_run_id} and r.org_id = ${opts.orgId}
    `);
  });
  await event({ orgId: opts.orgId, runId: instruction.payment_run_id, instructionId: opts.instructionId, actorId: opts.userId, eventType: `instruction_${opts.status}`, fromStatus: instruction.status, toStatus: opts.status, details: { bankReference: opts.bankReference, returnCode: opts.returnCode, returnReason: opts.returnReason } });
}

export async function runDuePaymentSchedules(now = new Date()): Promise<Array<{ scheduleId: string; runId?: string; selected: number; error?: string }>> {
  // Finding which tenants have a payment schedule due spans organizations, so
  // the scan and its claim cross an explicit trusted boundary; selecting bills
  // and creating the run happen inside that tenant's own scope. A scheduler tick
  // holds no request store — without these, RLS denies by default and no
  // scheduled payment run is ever created.
  const schedules = await withBypassContext(() =>
    db.execute<{
    id: string; org_id: string; payment_bank_profile_id: string; cron: string; timezone: string;
    selection_criteria: Record<string, unknown>; action: string; created_by: string | null;
    currency: string; subsidiary_id: string | null;
  }>(sql`
    select s.id, s.org_id, s.payment_bank_profile_id, s.cron, s.timezone, s.selection_criteria,
           s.action, s.created_by, p.currency, p.subsidiary_id
      from payment_schedules s
      join payment_bank_profiles p on p.id = s.payment_bank_profile_id and p.org_id = s.org_id and p.is_active
      join orgs o on o.id = s.org_id and o.env_kind = 'production'
     where s.is_active and s.next_run_at <= ${now}
     order by s.next_run_at
  `));
  const outcomes: Array<{ scheduleId: string; runId?: string; selected: number; error?: string }> = [];
  for (const schedule of schedules.rows) {
    const next = computeNextRunAt(schedule.cron, now, schedule.timezone);
    const claimed = await withBypassContext(() =>
      db.execute<{ id: string }>(sql`
      update payment_schedules set next_run_at = ${next}, last_run_at = ${now}
       where id = ${schedule.id} and org_id = ${schedule.org_id} and next_run_at <= ${now}
       returning id
    `));
    if (!claimed.rows[0]) continue;
    const criteria = schedule.selection_criteria ?? {};
    const dueDays = Math.max(0, Math.min(3650, Number(criteria.dueThroughDays ?? 0)));
    const minimum = String(criteria.minimumAmount ?? "0");
    const maximum = criteria.maximumRunAmount == null || criteria.maximumRunAmount === "" ? null : String(criteria.maximumRunAmount);
    try {
      await withOrgContext(schedule.org_id, async () => {
        // The org's calendar day bounds due bills and stamps the created run.
        const businessDate = await businessToday(schedule.org_id);
      const candidates = (await db.execute<{ id: string; open_balance: string }>(sql`
        select d.id, d.open_balance
          from documents d
         where d.org_id = ${schedule.org_id} and d.kind = 'vendor_bill' and d.status = 'posted'
           and d.payment_hold_reason is null and d.open_balance > 0
           and d.open_balance >= ${minimum}
           and d.currency = ${schedule.currency}
           and (${schedule.subsidiary_id}::uuid is null or d.subsidiary_id = ${schedule.subsidiary_id})
           and coalesce(d.due_date, d.document_date) <= (${businessDate}::date + ${dueDays}::integer)
         order by coalesce(d.due_date, d.document_date), d.document_number
      `));
      const selected: string[] = [];
      let accumulated = 0n;
      const cap = maximum ? toUnits(maximum) : null;
      for (const bill of candidates.rows) {
        const amount = toUnits(bill.open_balance);
        if (cap !== null && accumulated + amount > cap) continue;
        selected.push(bill.id);
        accumulated += amount;
      }
      if (selected.length === 0) {
        const result = { scheduleId: schedule.id, selected: 0 };
        outcomes.push(result);
        await db.execute(sql`update payment_schedules set last_result = ${JSON.stringify(result)}::jsonb where id = ${schedule.id} and org_id = ${schedule.org_id}`);
        return;
      }
      const actor = schedule.created_by ?? schedule.org_id;
      const run = await createPaymentRun({
        orgId: schedule.org_id,
        createdBy: actor,
        paymentBankProfileId: schedule.payment_bank_profile_id,
        billDocumentIds: selected,
        scheduledFor: businessDate,
        sourceScheduleId: schedule.id,
        selectionCriteria: criteria,
      });
      if (schedule.action === "submit_for_approval") await submitPaymentRun(run.id, schedule.org_id, actor);
      const result = { scheduleId: schedule.id, runId: run.id, selected: selected.length };
      outcomes.push(result);
      await db.execute(sql`update payment_schedules set last_payment_run_id = ${run.id}, last_result = ${JSON.stringify(result)}::jsonb where id = ${schedule.id} and org_id = ${schedule.org_id}`);
      });
    } catch (error) {
      const result = { scheduleId: schedule.id, selected: 0, error: error instanceof Error ? error.message : String(error) };
      outcomes.push(result);
      await withOrgContext(schedule.org_id, () =>
        db.execute(sql`update payment_schedules set last_result = ${JSON.stringify(result)}::jsonb where id = ${schedule.id} and org_id = ${schedule.org_id}`));
    }
  }
  return outcomes;
}
