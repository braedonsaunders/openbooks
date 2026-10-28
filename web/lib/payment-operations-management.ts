import "server-only";
import { sql } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/platform/db";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  createPaymentBankProfile,
  updatePaymentBankProfile,
  type PaymentBankProfileInput,
} from "@openbooks/engine/payments/operations";
import { payablePayeeBankAccountSql } from "@openbooks/engine/payments/run-readiness";
import { computeNextRunAt } from "@openbooks/engine/scripting/scripting";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { normalizeCountryCode } from "./countries";
import { isFeatureEnabled } from "./features";
import { isUuid } from "./list-params";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import { auditConfigChange } from "./payment-operations-audit";
import type { Authz } from "./authz";

export type PaymentOperationResource = "formats" | "profiles" | "schedules" | "mandates";
export type PaymentOperationContext = { authz: Authz; requestId?: string | null };

export class PaymentOperationManagementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "PaymentOperationManagementError";
  }
}

export type PaymentOperationInput = Record<string, unknown> & {
  action?: "create_draft" | "submit_for_approval";
  bankAccountId?: string;
  code?: string;
  contentType?: string;
  country?: string | null;
  cron?: string;
  currency?: string;
  direction?: "credit" | "debit" | "both";
  expiresOn?: string;
  fileExtension?: string;
  formatterScript?: string;
  isActive?: boolean;
  mandateReference?: string;
  name?: string;
  originatorSecrets?: Record<string, unknown> | null;
  partyBankAccountId?: string;
  partyId?: string;
  paymentBankProfileId?: string;
  paymentFormatId?: string;
  proofFileId?: string;
  scheme?: "nacha" | "sepa_core" | "sepa_b2b" | "custom";
  sftpFolder?: string | null;
  sftpServerId?: string | null;
  selectionCriteria?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  signedOn?: string;
  status?: "pending" | "active" | "suspended" | "revoked" | "expired";
  subsidiaryId?: string | null;
  autoRemittance?: boolean;
  timezone?: string;
  validFrom?: string;
};

function actor(context: PaymentOperationContext) {
  return context.authz.user;
}

function country(value: unknown): string | null | undefined {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  return normalizeCountryCode(value) ?? undefined;
}

async function requireCurrencyFeature(
  context: PaymentOperationContext,
  input: PaymentOperationInput,
) {
  if (
    input.currency !== undefined &&
    !(await isFeatureEnabled(actor(context).orgId, "multiCurrency"))
  ) {
    throw new PaymentOperationManagementError("record not found", 404);
  }
}

function invalidCountry(): never {
  throw new PaymentOperationManagementError("country must be a valid ISO country code", 400);
}

function invalid(message: string, status: 400 | 404 | 409 | 422 = 400): never {
  throw new PaymentOperationManagementError(message, status);
}

export async function listPaymentOperationConfigs(
  resource: PaymentOperationResource,
  context: PaymentOperationContext,
) {
  const gate = context.authz;
  if (resource === "formats") {
    const rows = await db.execute(
      sql`select id, code, name, rail, direction, country, currency, file_extension,
                 content_type, formatter_script is not null as has_formatter, is_active
            from payment_formats where org_id = ${gate.user.orgId} order by is_active desc, name`,
      "objects",
    );
    return { rows };
  }
  if (resource === "profiles") {
    const rows = await db.execute(
      sql`select p.id, p.name, p.bank_account_id, p.subsidiary_id, p.payment_format_id,
                 p.currency, p.country, p.settings, p.sftp_server_id, p.sftp_folder,
                 p.auto_remittance, p.originator_secrets_encrypted is not null as has_secrets,
                 p.is_active, f.name as format_name, f.rail, a.number as bank_number, a.name as bank_name
            from payment_bank_profiles p
            join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
            join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
           where p.org_id = ${gate.user.orgId}
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
           order by p.is_active desc, p.name`,
      "objects",
    );
    return { rows };
  }
  if (resource === "schedules") {
    const rows = await db.execute(
      sql`select s.*, p.name as profile_name
            from payment_schedules s
            join payment_bank_profiles p on p.id = s.payment_bank_profile_id and p.org_id = s.org_id
            join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
           where s.org_id = ${gate.user.orgId}
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
           order by s.is_active desc, s.name`,
      "objects",
    );
    return { rows };
  }
  const rows = await db.execute(
    sql`select m.*, p.display_name as party_name, b.bank_name, b.account_last_four
          from payment_mandates m
          join parties p on p.id = m.party_id and p.org_id = m.org_id
          join party_bank_accounts b on b.id = m.party_bank_account_id and b.org_id = m.org_id
         where m.org_id = ${gate.user.orgId}
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
         order by m.created_at desc`,
    "objects",
  );
  return { rows };
}

export async function createPaymentFormatRecord(
  context: PaymentOperationContext,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  await requireCurrencyFeature(context, input);
  if (!input.code?.trim() || !input.name?.trim() || !input.formatterScript?.trim()) {
    invalid("code, name, and formatterScript are required");
  }
  const normalizedCountry = country(input.country);
  if (normalizedCountry === undefined) invalidCountry();
  const row = await db.transaction(async (tx) => {
    const created = (
      await tx
        .insert(schema.paymentFormats)
        .values({
          orgId: user.orgId,
          code: input.code!.trim().toUpperCase(),
          name: input.name!.trim(),
          rail: "custom",
          direction:
            input.direction === "debit" || input.direction === "both" ? input.direction : "credit",
          country: normalizedCountry,
          currency:
            input.currency !== undefined ? input.currency.trim().toUpperCase() || null : null,
          fileExtension: input.fileExtension?.trim().replace(/^\./, "") || "txt",
          contentType: input.contentType?.trim() || "text/plain; charset=utf-8",
          formatterScript: input.formatterScript!,
          settings: input.settings ?? {},
          isActive: input.isActive !== false,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning()
    )[0]!;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_formats",
      created.id,
      "insert",
      { after: created },
      user.id,
      context.requestId,
    );
    return created;
  });
  return { id: row.id };
}

export async function createPaymentProfileRecord(
  context: PaymentOperationContext,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  await requireCurrencyFeature(context, input);
  const normalizedCountry = country(input.country);
  if (normalizedCountry === undefined) invalidCountry();
  if (!input.name || !isUuid(input.bankAccountId ?? "") || !isUuid(input.paymentFormatId ?? "")) {
    invalid("name, bankAccountId, and paymentFormatId are required");
  }
  let currency = input.currency !== undefined ? input.currency.trim().toUpperCase() : "";
  if (input.currency === undefined) {
    const fallback = await db.execute<{ currency: string | null }>(
      sql`select coalesce(nullif(f.currency, ''), s.base_currency, o.base_currency) as currency
            from orgs o
            left join payment_formats f on f.id = ${input.paymentFormatId} and f.org_id = o.id
            left join subsidiaries s on s.id = ${input.subsidiaryId ?? null} and s.org_id = o.id
           where o.id = ${user.orgId}`,
      "objects",
    );
    currency = fallback[0]?.currency ?? "";
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    invalid("name, bankAccountId, paymentFormatId, and currency are required");
  }
  const profile = await createPaymentBankProfile(
    user.orgId,
    user.id,
    { ...input, country: normalizedCountry, currency } as unknown as PaymentBankProfileInput,
    context.authz.allowedSubsidiaryIds,
  );
  return profile;
}

export async function createPaymentScheduleRecord(
  context: PaymentOperationContext,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  if (!input.name?.trim() || !isUuid(input.paymentBankProfileId ?? "") || !input.cron?.trim()) {
    invalid("name, paymentBankProfileId, and cron are required");
  }
  const timezone = input.timezone?.trim() || "UTC";
  const cron = input.cron!.trim();
  const nextRunAt = computeNextRunAt(cron, new Date(), timezone);
  if (!nextRunAt) invalid("cron expression is invalid");
  const profile = await db.execute(
    sql`select 1 from payment_bank_profiles p
          join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
         where p.id = ${input.paymentBankProfileId} and p.org_id = ${user.orgId}
           and p.is_active and f.direction <> 'debit'`,
    "objects",
  );
  if (!profile[0]) invalid("payment profile is invalid or inactive");
  const row = await db.transaction(async (tx) => {
    const created = (
      await tx
        .insert(schema.paymentSchedules)
        .values({
          orgId: user.orgId,
          name: input.name!.trim(),
          paymentBankProfileId: input.paymentBankProfileId!,
          cron,
          timezone,
          selectionCriteria: input.selectionCriteria ?? {},
          action: input.action === "submit_for_approval" ? "submit_for_approval" : "create_draft",
          nextRunAt,
          isActive: input.isActive !== false,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning()
    )[0]!;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_schedules",
      created.id,
      "insert",
      { after: created },
      user.id,
      context.requestId,
    );
    return created;
  });
  return { id: row.id };
}

export async function createPaymentMandateRecord(
  context: PaymentOperationContext,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  if (
    !isUuid(input.partyId ?? "") ||
    !isUuid(input.partyBankAccountId ?? "") ||
    !input.mandateReference?.trim()
  ) {
    invalid("partyId, partyBankAccountId, and mandateReference are required");
  }
  const scheme = input.scheme ?? "custom";
  const status = input.status ?? "pending";
  const creation = await db.transaction(async (tx) => {
    const party = (
      await tx.execute(
        sql`select p.id from parties p
              where p.id = ${input.partyId} and p.org_id = ${user.orgId} and p.is_active
                ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds, { orgWideNull: true })}
              for update`,
        "objects",
      )
    )[0];
    if (!party) return { kind: "not-found" as const };
    const bank = await tx.execute(
      sql`select 1 from party_bank_accounts b
            where b.id = ${input.partyBankAccountId} and b.party_id = ${input.partyId}
              and b.org_id = ${user.orgId} and ${payablePayeeBankAccountSql("b")}
            for update`,
      "objects",
    );
    if (!bank[0]) return { kind: "invalid-bank" as const };
    const created = (
      await tx
        .insert(schema.paymentMandates)
        .values({
          orgId: user.orgId,
          partyId: input.partyId!,
          partyBankAccountId: input.partyBankAccountId!,
          scheme,
          mandateReference: input.mandateReference!.trim(),
          status,
          signedOn: input.signedOn || null,
          validFrom: input.validFrom || null,
          expiresOn: input.expiresOn || null,
          proofFileId: isUuid(input.proofFileId ?? "") ? input.proofFileId : null,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning()
    )[0]!;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_mandates",
      created.id,
      "insert",
      { after: created },
      user.id,
      context.requestId,
    );
    return { kind: "created" as const, row: created };
  });
  if (creation.kind === "not-found") invalid("record not found", 404);
  if (creation.kind === "invalid-bank") invalid("approved counterparty bank account is invalid");
  return { id: creation.row.id };
}

export async function updatePaymentFormatRecord(
  context: PaymentOperationContext,
  id: string,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  await requireCurrencyFeature(context, input);
  if (input.name !== undefined && !input.name.trim()) invalid("name cannot be empty");
  if (input.formatterScript !== undefined && !input.formatterScript.trim()) {
    invalid("formatterScript cannot be empty");
  }
  const normalizedCountry = input.country === undefined ? undefined : country(input.country);
  if (normalizedCountry === undefined && input.country !== undefined) invalidCountry();
  const result = await db.transaction(async (tx) => {
    const before = (
      await tx.execute<Record<string, unknown>>(
        sql`select * from payment_formats where id = ${id} and org_id = ${user.orgId} and rail = 'custom' for update`,
        "objects",
      )
    )[0];
    if (!before) return "missing" as const;
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`update payment_formats set
              name = coalesce(${input.name?.trim() ?? null}, name),
              country = case when ${input.country === undefined} then country else ${normalizedCountry ?? null} end,
              currency = case when ${input.currency === undefined} then currency else ${input.currency?.trim().toUpperCase() || null} end,
              file_extension = coalesce(${input.fileExtension?.trim().replace(/^\./, "") ?? null}, file_extension),
              content_type = coalesce(${input.contentType?.trim() ?? null}, content_type),
              formatter_script = case when ${input.formatterScript === undefined} then formatter_script else ${input.formatterScript || null} end,
              is_active = coalesce(${input.isActive ?? null}, is_active), updated_at = now(), updated_by = ${user.id}
            where id = ${id} and org_id = ${user.orgId} and rail = 'custom' returning *`,
        "objects",
      )
    )[0];
    if (!after) return "missing" as const;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_formats",
      id,
      "update",
      { before, after },
      user.id,
      context.requestId,
    );
    return "updated" as const;
  });
  if (result === "missing") invalid("built-in payment formats are read-only", 409);
  return { ok: true };
}

export async function updatePaymentProfileRecord(
  context: PaymentOperationContext,
  id: string,
  input: PaymentOperationInput,
) {
  await requireCurrencyFeature(context, input);
  const normalizedCountry = input.country === undefined ? undefined : country(input.country);
  if (normalizedCountry === undefined && input.country !== undefined) invalidCountry();
  await updatePaymentBankProfile(
    id,
    actor(context).orgId,
    actor(context).id,
    { ...input, country: normalizedCountry },
    context.authz.allowedSubsidiaryIds,
  );
  return { ok: true };
}

export async function updatePaymentScheduleRecord(
  context: PaymentOperationContext,
  id: string,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  if (
    input.action !== undefined &&
    input.action !== "submit_for_approval" &&
    input.action !== "create_draft"
  ) {
    invalid("action must be submit_for_approval or create_draft");
  }
  const current = await db.execute<{ cron: string; timezone: string }>(
    sql`select cron, timezone from payment_schedules where id = ${id} and org_id = ${user.orgId}`,
    "objects",
  );
  if (!current[0]) invalid("record not found", 404);
  const next =
    input.cron || input.timezone
      ? computeNextRunAt(
          input.cron?.trim() || current[0]!.cron,
          new Date(),
          input.timezone?.trim() || current[0]!.timezone,
        )
      : undefined;
  if ((input.cron || input.timezone) && !next) invalid("cron expression or time zone is invalid");
  if (input.paymentBankProfileId) {
    const profile = await db.execute(
      sql`select 1 from payment_bank_profiles p
            join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
           where p.id = ${input.paymentBankProfileId} and p.org_id = ${user.orgId}
             and p.is_active and f.direction <> 'debit'`,
      "objects",
    );
    if (!profile[0]) invalid("payment profile is invalid or inactive");
  }
  const result = await db.transaction(async (tx) => {
    const before = (
      await tx.execute<Record<string, unknown>>(
        sql`select * from payment_schedules where id = ${id} and org_id = ${user.orgId}`,
        "objects",
      )
    )[0];
    if (!before) return "missing" as const;
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`update payment_schedules set
              name = coalesce(${input.name?.trim() ?? null}, name),
              payment_bank_profile_id = coalesce(${input.paymentBankProfileId ?? null}::uuid, payment_bank_profile_id),
              cron = coalesce(${input.cron?.trim() ?? null}, cron),
              timezone = coalesce(${input.timezone?.trim() ?? null}, timezone),
              selection_criteria = coalesce(${input.selectionCriteria ? JSON.stringify(input.selectionCriteria) : null}::jsonb, selection_criteria),
              action = coalesce(${input.action ?? null}, action),
              next_run_at = coalesce(${next ?? null}, next_run_at),
              is_active = coalesce(${input.isActive ?? null}, is_active), updated_at = now(), updated_by = ${user.id}
            where id = ${id} and org_id = ${user.orgId} returning *`,
        "objects",
      )
    )[0];
    if (!after) return "missing" as const;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_schedules",
      id,
      "update",
      { before, after },
      user.id,
      context.requestId,
    );
    return "updated" as const;
  });
  if (result === "missing") invalid("record not found", 404);
  return { ok: true };
}

export async function updatePaymentMandateRecord(
  context: PaymentOperationContext,
  id: string,
  input: PaymentOperationInput,
) {
  const user = actor(context);
  for (const [field, label] of [
    ["signedOn", "signed date"],
    ["validFrom", "valid-from date"],
    ["expiresOn", "expiry date"],
  ] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== "" && !isIsoCalendarDate(value)) {
      invalid(`${label} must be a real calendar date (YYYY-MM-DD)`);
    }
  }
  const result = await db.transaction(async (tx) => {
    const candidate = (
      await tx.execute<{ party_id: string }>(
        sql`select party_id from payment_mandates where id = ${id} and org_id = ${user.orgId}`,
        "objects",
      )
    )[0];
    if (!candidate) return "missing" as const;
    const party = (
      await tx.execute(
        sql`select p.id from parties p
              where p.id = ${candidate.party_id} and p.org_id = ${user.orgId} and p.is_active
                ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds, { orgWideNull: true })}
              for update`,
        "objects",
      )
    )[0];
    if (!party) return "missing" as const;
    const before = (
      await tx.execute<Record<string, unknown>>(
        sql`select * from payment_mandates where id = ${id} and org_id = ${user.orgId} for update`,
        "objects",
      )
    )[0];
    if (!before || before.party_id !== candidate.party_id) return "missing" as const;
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`update payment_mandates set
              status = coalesce(${input.status ?? null}, status),
              signed_on = case when ${input.signedOn === undefined} then signed_on else ${input.signedOn || null}::date end,
              valid_from = case when ${input.validFrom === undefined} then valid_from else ${input.validFrom || null}::date end,
              expires_on = case when ${input.expiresOn === undefined} then expires_on else ${input.expiresOn || null}::date end,
              updated_at = now(), updated_by = ${user.id}
            where id = ${id} and org_id = ${user.orgId} returning *`,
        "objects",
      )
    )[0];
    if (!after) return "missing" as const;
    await auditConfigChange(
      tx,
      user.orgId,
      "payment_mandates",
      id,
      "update",
      { before, after },
      user.id,
      context.requestId,
    );
    return "updated" as const;
  });
  if (result === "missing") invalid("record not found", 404);
  return { ok: true };
}

export function settlePaymentOperationRouteError(error: unknown): {
  status: 400 | 404 | 409 | 422;
  message: string;
} {
  if (error instanceof PaymentOperationManagementError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ScopeNotFoundError) return { status: 404, message: "record not found" };
  return {
    status: 422,
    message: error instanceof Error ? error.message : "request failed",
  };
}
