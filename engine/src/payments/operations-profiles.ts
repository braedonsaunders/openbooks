import { sql } from "drizzle-orm";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { validateChequeBank } from "../payments-core/cheque-bank.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { validateNachaSettings, type NachaSettings } from "../payments-core/rail-nacha.ts";
import {
  validateRbcStd152Settings,
  type RbcStd152Settings,
} from "../payments-core/rail-rbc-std152.ts";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";

export type BuiltInPaymentRail =
  | "rbc_std152_credit"
  | "cpa005_credit"
  | "nacha_credit"
  | "sepa_credit"
  | "cemtex_credit"
  | "bacs_credit"
  | "zengin_credit"
  | "cnab240_bb_credit"
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
  {
    code: "RBC-STD152",
    name: "RBC STD152 Canadian-bank credit",
    rail: "rbc_std152_credit",
    direction: "credit",
    country: "CA",
    currency: "CAD",
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "CPA005",
    name: "CPA Standard 005 credit",
    rail: "cpa005_credit",
    direction: "credit",
    country: "CA",
    currency: "CAD",
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "NACHA-CREDIT",
    name: "NACHA ACH credit",
    rail: "nacha_credit",
    direction: "credit",
    country: "US",
    currency: "USD",
    extension: "ach",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "SEPA-CREDIT",
    name: "SEPA credit transfer",
    rail: "sepa_credit",
    direction: "credit",
    country: null,
    currency: "EUR",
    extension: "xml",
    contentType: "application/xml",
  },
  // `cemtex_credit`, never `aba_credit`: ABA already means the US 9-digit routing number in this codebase.
  {
    code: "CEMTEX-CREDIT",
    name: "Cemtex (ABA) credit transfer",
    rail: "cemtex_credit",
    direction: "credit",
    country: "AU",
    currency: "AUD",
    extension: "aba",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "BACS-CREDIT",
    name: "Bacs Standard 18 credit transfer",
    rail: "bacs_credit",
    direction: "credit",
    country: "GB",
    currency: "GBP",
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "ZENGIN-CREDIT",
    name: "Zengin salary transfer",
    rail: "zengin_credit",
    direction: "credit",
    country: "JP",
    currency: "JPY",
    extension: "txt",
    contentType: "text/plain; charset=Shift_JIS",
  },
  {
    code: "CNAB240-BB-CREDIT",
    name: "CNAB 240 Pagamentos (Banco do Brasil)",
    rail: "cnab240_bb_credit",
    direction: "credit",
    country: "BR",
    currency: "BRL",
    extension: "rem",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "NACHA-DEBIT",
    name: "NACHA ACH debit",
    rail: "nacha_debit",
    direction: "debit",
    country: "US",
    currency: "USD",
    extension: "ach",
    contentType: "text/plain; charset=us-ascii",
  },
  {
    code: "SEPA-DEBIT",
    name: "SEPA direct debit",
    rail: "sepa_debit",
    direction: "debit",
    country: null,
    currency: "EUR",
    extension: "xml",
    contentType: "application/xml",
  },
  {
    code: "POSITIVE-PAY",
    name: "Positive Pay",
    rail: "positive_pay",
    direction: "credit",
    country: null,
    currency: null,
    extension: "csv",
    contentType: "text/csv; charset=utf-8",
  },
  {
    code: "WIRE",
    name: "Wire instruction",
    rail: "wire",
    direction: "credit",
    country: null,
    currency: null,
    extension: "csv",
    contentType: "text/csv; charset=utf-8",
  },
  {
    code: "CHEQUE",
    name: "Cheque register",
    rail: "cheque",
    direction: "credit",
    country: null,
    currency: null,
    extension: "csv",
    contentType: "text/csv; charset=utf-8",
  },
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
      where payment_formats.org_id = ${orgId}
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
  autoRemittance?: boolean;
  isActive?: boolean;
}

async function validatePaymentBankProfileRefs(
  orgId: string,
  input: {
    bankAccountId: string;
    paymentFormatId: string;
    subsidiaryId?: string | null;
    sftpServerId?: string | null;
    currency: string;
    country?: string | null;
    settings?: Record<string, unknown>;
    originatorSecrets?: Record<string, unknown> | null;
  },
): Promise<void> {
  const result = await db.execute<{ format_currency: string | null; rail: string }>(
    sql`
    select f.currency as format_currency, f.rail
      from payment_formats f
      join accounts a on a.id = ${input.bankAccountId} and a.org_id = f.org_id
                         and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where f.id = ${input.paymentFormatId} and f.org_id = ${orgId} and f.is_active
       and (${input.subsidiaryId ?? null}::uuid is null or exists (
         select 1 from subsidiaries s where s.id = ${input.subsidiaryId ?? null} and s.org_id = ${orgId} and s.is_active))
       and (${input.sftpServerId ?? null}::uuid is null or exists (
         select 1 from sftp_servers sv where sv.id = ${input.sftpServerId ?? null} and sv.org_id = ${orgId} and sv.is_active))
  `,
    "objects",
  );
  const row = result[0];
  if (!row)
    throw new PaymentError(
      "select active tenant-owned payment, bank, subsidiary, and delivery records",
    );
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new PaymentError("currency must be a three-letter ISO code");
  if (row.format_currency && row.format_currency !== input.currency) {
    throw new PaymentError(`the selected format requires ${row.format_currency}`);
  }
  const discountAccountId = input.settings?.discountAccountId;
  if (typeof discountAccountId === "string" && discountAccountId) {
    const account = await db.execute<{ id: string }>(
      sql`
      select id from accounts where id = ${discountAccountId} and org_id = ${orgId} and is_active and not is_summary
    `,
      "objects",
    );
    if (!account[0]) throw new PaymentError("discount account is invalid or inactive");
  }
  if (
    row.rail === "positive_pay" &&
    !String(input.settings?.positivePayAccountReference ?? "").trim()
  ) {
    throw new PaymentError("Positive Pay requires the institution's bank account reference");
  }
  if (row.rail === "rbc_std152_credit") {
    const checked = validateRbcStd152Settings(
      (input.originatorSecrets ?? {}) as Partial<RbcStd152Settings>,
    );
    if (!checked.ok)
      throw new PaymentError(
        `RBC STD152 configuration is incomplete: ${checked.missing.join(", ")}`,
      );
    if (input.currency !== "CAD" || checked.settings.serviceCurrency !== "CAD")
      throw new PaymentError("the available RBC STD152 format requires a CAD service and profile");
    if (checked.settings.serviceCurrency !== input.currency)
      throw new PaymentError("RBC service currency must match the profile currency");
    if (input.country !== "CA")
      throw new PaymentError("RBC STD152 Canadian-bank credits require a CA profile");
  }
  if (
    row.rail === "cheque" &&
    input.originatorSecrets &&
    ["bankName", "branchAddress", "accountEncoding", "effectiveFrom"].some(
      (key) => input.originatorSecrets?.[key] !== undefined,
    )
  ) {
    validateChequeBank(input.originatorSecrets);
    if (input.country !== "CA" || input.currency !== "CAD")
      throw new PaymentError(
        "Printed Canadian MICR requires a CAD Canadian cheque profile; use preprinted bank stock for other formats",
      );
  }
  const transactionCode = input.originatorSecrets?.transactionCode;
  if (
    row.rail === "cpa005_credit" &&
    transactionCode !== undefined &&
    (typeof transactionCode !== "string" || !/^\d{3}$/.test(transactionCode))
  ) {
    throw new PaymentError(
      "CPA-005 transaction code override must be three digits; omit it to use the standard 460 code",
    );
  }
  // NACHA originator configuration is validated on save through the same
  // validator the pay run readiness check uses, so a profile that saves is
  // one whose runs report ready: every missing or malformed originator
  // field is named, plus the profile country the file header needs.
  if (row.rail === "nacha_credit" || row.rail === "nacha_debit") {
    const problems: string[] = [];
    const checked = validateNachaSettings(
      (input.originatorSecrets ?? null) as Partial<NachaSettings>,
    );
    if (!checked.ok) problems.push(...checked.missing);
    const country = input.country?.trim() ?? "";
    if (!/^[A-Za-z]{2}$/.test(country)) problems.push("country (2-letter ISO code)");
    if (problems.length > 0) {
      throw new PaymentError(
        `NACHA originator configuration is incomplete: ${problems.join(", ")}`,
      );
    }
  }
}

/** Audit-safe projection: sealed originator credentials never enter the trail. */
function profileAuditView(row: Record<string, unknown>): Record<string, unknown> {
  const { originator_secrets_encrypted, originatorSecretsEncrypted, ...rest } = row;
  return {
    ...rest,
    hasOriginatorSecrets:
      originator_secrets_encrypted != null || originatorSecretsEncrypted != null,
  };
}

async function auditProfileChange(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  rowId: string,
  action: string,
  changes: unknown,
  actorId: string,
): Promise<void> {
  const audit = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payment_bank_profiles', ${rowId}, ${action},
            ${JSON.stringify(changes)}::jsonb, ${actorId}) returning id
  `,
    "objects",
  );
  if (audit.length !== 1) throw new PaymentError("Bank profile audit was not recorded");
}

/**
 * A profile points at a bank account and optionally a subsidiary: both must
 * be visible to the caller, checked here under the account row lock so a
 * concurrent subsidiary move cannot slip between the check and the insert.
 * A missing, cross-org, or out-of-scope account answers the uniform
 * not-found. Null scope is the unrestricted caller.
 */
async function requireProfileScope(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  bankAccountId: string,
  subsidiaryId: string | null | undefined,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const account = await tx.execute<{ subsidiary_id: string | null }>(
    sql`
    select subsidiary_id from accounts where id = ${bankAccountId} and org_id = ${orgId} for share`,
    "objects",
  );
  if (
    !account[0] ||
    !subsidiaryScopeAllows(scope, account[0].subsidiary_id, { orgWideNull: true }) ||
    !subsidiaryScopeAllows(scope, subsidiaryId ?? null, { orgWideNull: true })
  ) {
    throw new ScopeNotFoundError();
  }
}

/** Creates a profile without ever persisting plaintext originator credentials. */
export async function createPaymentBankProfile(
  orgId: string,
  userId: string,
  input: PaymentBankProfileInput,
  scope: ReadonlySet<string> | null = null,
): Promise<{ id: string }> {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      const actorScope = await lockActorCommandAuthority(
        tx,
        orgId,
        userId,
        input.subsidiaryId ?? null,
        "admin.setup.manage",
      );
      await validatePaymentBankProfileRefs(orgId, input);
      await requireProfileScope(tx, orgId, input.bankAccountId, input.subsidiaryId, actorScope);
      await requireProfileScope(tx, orgId, input.bankAccountId, input.subsidiaryId, scope);
      const profile = (
        await tx
          .insert(schema.paymentBankProfiles)
          .values({
            orgId,
            name: input.name.trim(),
            bankAccountId: input.bankAccountId,
            subsidiaryId: input.subsidiaryId ?? null,
            paymentFormatId: input.paymentFormatId,
            currency: input.currency,
            country: input.country ?? null,
            originatorSecretsEncrypted: input.originatorSecrets
              ? sealJson(input.originatorSecrets, { orgId, purpose: "payment.originator.secrets" })
              : null,
            settings: input.settings ?? {},
            sftpServerId: input.sftpServerId ?? null,
            sftpFolder: input.sftpFolder ?? null,
            autoRemittance: input.autoRemittance ?? false,
            isActive: input.isActive ?? true,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning({ id: schema.paymentBankProfiles.id })
      )[0]!;
      const stored = await tx.execute<Record<string, unknown>>(
        sql`
      select * from payment_bank_profiles where id = ${profile.id} and org_id = ${orgId}
    `,
        "objects",
      );
      await auditProfileChange(
        tx,
        orgId,
        profile.id,
        "insert",
        { after: profileAuditView(stored[0]!) },
        userId,
      );
      return profile;
    }),
  );
}

export async function updatePaymentBankProfile(
  id: string,
  orgId: string,
  userId: string,
  input: Partial<PaymentBankProfileInput>,
  scope: ReadonlySet<string> | null = null,
): Promise<void> {
  await withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      const existing = await tx.execute<
        Record<string, unknown> & {
          bank_account_id: string;
          subsidiary_id: string | null;
          payment_format_id: string;
          currency: string;
          country: string | null;
          settings: Record<string, unknown>;
          sftp_server_id: string | null;
          originator_secrets_encrypted: string | null;
        }
      >(
        sql`
      select * from payment_bank_profiles where id = ${id} and org_id = ${orgId}
       for update
    `,
        "objects",
      );
      if (!existing[0]) throw new PaymentError("payment bank profile not found");
      const current = existing[0];
      const actorScope = await lockActorCommandAuthority(
        tx,
        orgId,
        userId,
        current.subsidiary_id,
        "admin.setup.manage",
      );
      await lockActorCommandAuthority(
        tx,
        orgId,
        userId,
        input.subsidiaryId === undefined ? current.subsidiary_id : input.subsidiaryId,
        "admin.setup.manage",
      );
      await requireProfileScope(
        tx,
        orgId,
        input.bankAccountId ?? current.bank_account_id,
        input.subsidiaryId === undefined ? current.subsidiary_id : input.subsidiaryId,
        actorScope,
      );
      const rotating = input.originatorSecrets !== undefined;
      const storedOriginatorSecrets =
        current.originator_secrets_encrypted == null
          ? null
          : unsealJson<Record<string, unknown>>(current.originator_secrets_encrypted, {
              orgId,
              purpose: "payment.originator.secrets",
            });
      const originatorSecrets = rotating
        ? input.originatorSecrets === null
          ? null
          : {
              ...(storedOriginatorSecrets ?? {}),
              ...input.originatorSecrets,
            }
        : storedOriginatorSecrets;
      await validatePaymentBankProfileRefs(orgId, {
        bankAccountId: input.bankAccountId ?? current.bank_account_id,
        subsidiaryId: input.subsidiaryId === undefined ? current.subsidiary_id : input.subsidiaryId,
        paymentFormatId: input.paymentFormatId ?? current.payment_format_id,
        currency: input.currency ?? current.currency,
        country: input.country === undefined ? current.country : input.country,
        settings: input.settings ?? current.settings,
        sftpServerId:
          input.sftpServerId === undefined ? current.sftp_server_id : input.sftpServerId,
        originatorSecrets,
      });
      // Repointing at another subsidiary's bank account is the same privilege
      // as creating there: refuse it under the same account lock, against the
      // effective (merged) refs rather than only the submitted patch.
      await requireProfileScope(
        tx,
        orgId,
        input.bankAccountId ?? current.bank_account_id,
        input.subsidiaryId === undefined ? current.subsidiary_id : input.subsidiaryId,
        scope,
      );
      const secret = rotating
        ? input.originatorSecrets === null
          ? null
          : sealJson(originatorSecrets ?? {}, { orgId, purpose: "payment.originator.secrets" })
        : current.originator_secrets_encrypted;
      const write = await tx.execute<{ id: string }>(
        sql`
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
        auto_remittance = coalesce(${input.autoRemittance ?? null}, auto_remittance),
        is_active = coalesce(${input.isActive ?? null}, is_active),
        updated_at = now(), updated_by = ${userId}
      where id = ${id} and org_id = ${orgId}
      returning id
    `,
        "objects",
      );
      if (!write[0]) throw new PaymentError("payment bank profile not found");
      const updated = await tx.execute<Record<string, unknown>>(
        sql`
      select * from payment_bank_profiles where id = ${id} and org_id = ${orgId}
    `,
        "objects",
      );
      if (!updated[0]) throw new PaymentError("payment bank profile not found");
      await auditProfileChange(
        tx,
        orgId,
        id,
        "update",
        {
          before: profileAuditView(current),
          after: profileAuditView(updated[0]),
          ...(rotating ? { originatorSecretsRotated: true } : {}),
        },
        userId,
      );
    }),
  );
}
