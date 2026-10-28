import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";
import { moneyRefusal } from "@openbooks/engine/money/decimal-refusal";
import { normalizeCountryCode } from "./countries";

const countrySchema = z
  .string()
  .max(50)
  .refine(
    (value) => value.trim() === "" || normalizeCountryCode(value) !== null,
    "country must be a valid ISO country code",
  )
  .nullable()
  .optional()
  .describe("Optional ISO country code; blank or null clears the country restriction.");
const currencySchema = z
  .string()
  .regex(/^(?:[A-Za-z]{3})?$/, "currency must be a three-letter code or blank")
  .optional()
  .describe("Optional three-letter currency code; blank clears the currency restriction.");
const calendarDateSchema = z
  .string()
  .max(10)
  .refine(
    (value) => value === "" || isIsoCalendarDate(value),
    "date must be a real calendar date (YYYY-MM-DD)",
  )
  .describe("Real calendar date in YYYY-MM-DD form; blank clears the date.");
const optionalScheduleAmountSchema = z
  .string()
  .max(40)
  .superRefine((value, ctx) => {
    if (value !== "" && canonicalDecimal(value, 4) === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal("Payment schedule amount", value) });
    }
  });
const selectionCriteriaSchema = z
  .object({
    dueThroughDays: z
      .number()
      .int()
      .min(0)
      .max(3650)
      .optional()
      .describe("Include bills due within this many days."),
    minimumAmount: optionalScheduleAmountSchema
      .optional()
      .describe("Optional exact minimum bill amount as a decimal string."),
    maximumRunAmount: optionalScheduleAmountSchema
      .optional()
      .describe("Optional exact maximum payment run amount as a decimal string."),
    captureDiscounts: z
      .boolean()
      .optional()
      .describe("Whether a run captures available early-payment discounts."),
    applyCredits: z.boolean().optional().describe("Whether a run applies available credits."),
  })
  .describe("Optional bill selection criteria and payment-run limits.");
const paymentFormatSettingsSchema = z
  .record(z.string(), z.json())
  .optional()
  .describe("JSON settings interpreted by this payment format.");
const paymentProfileSettingsSchema = z
  .record(z.string(), z.json())
  .optional()
  .describe("JSON settings for this bank profile.");
const originatorSecretsSchema = z
  .record(z.string(), z.string().max(1000))
  .nullable()
  .optional()
  .describe("Originator credentials; stored encrypted and omitted from configuration reads.");
const patchCountrySchema = z
  .string()
  .max(50)
  .refine((value) => value.trim() === "" || normalizeCountryCode(value) !== null)
  .nullable()
  .optional()
  .describe("Optional ISO country code; blank or null clears the country restriction.");
const patchCurrencySchema = z
  .string()
  .regex(/^(?:[A-Za-z]{3})?$/)
  .optional()
  .describe("Optional three-letter currency code; blank clears the currency restriction.");
const datePatchSchema = z
  .string()
  .max(10)
  .refine((value) => value === "" || isIsoCalendarDate(value))
  .optional()
  .describe("Real calendar date in YYYY-MM-DD form; blank clears the date.");
const scheduleAmountSchema = z
  .string()
  .max(40)
  .superRefine((value, ctx) => {
    if (value !== "" && canonicalDecimal(value, 4) === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal("Payment schedule amount", value) });
    }
  });
const patchSelectionCriteriaSchema = z
  .object({
    dueThroughDays: z
      .number()
      .int()
      .min(0)
      .max(3650)
      .optional()
      .describe("Include bills due within this many days."),
    minimumAmount: scheduleAmountSchema
      .optional()
      .describe("Optional exact minimum bill amount as a decimal string."),
    maximumRunAmount: scheduleAmountSchema
      .optional()
      .describe("Optional exact maximum payment run amount as a decimal string."),
    captureDiscounts: z
      .boolean()
      .optional()
      .describe("Whether a run captures available early-payment discounts."),
    applyCredits: z.boolean().optional().describe("Whether a run applies available credits."),
  })
  .describe("Optional bill selection criteria and payment-run limits.");

export const paymentFormatCreateBodySchema = z.object({
  code: z.string().trim().min(1).max(80).describe("Unique organization payment-format code."),
  name: z.string().trim().min(1).max(200).describe("Operator-facing payment format name."),
  formatterScript: z
    .string()
    .trim()
    .min(1)
    .max(100000)
    .describe("Formatter script used to generate the bank file."),
  direction: z
    .enum(["credit", "debit", "both"])
    .optional()
    .describe("Payment direction supported by this format."),
  country: countrySchema,
  currency: currencySchema,
  fileExtension: z.string().max(20).optional().describe("Generated file extension."),
  contentType: z.string().max(200).optional().describe("MIME content type for generated files."),
  settings: paymentFormatSettingsSchema,
  isActive: z.boolean().optional().describe("Whether bank profiles may use this format."),
});

export const paymentProfileCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).describe("Operator-facing bank profile name."),
  bankAccountId: uuidString().describe("Active bank ledger account id from account reads."),
  paymentFormatId: uuidString().describe(
    "Payment format id from list_payment_operation_configs with resource formats.",
  ),
  subsidiaryId: uuidString()
    .nullable()
    .optional()
    .describe("Optional subsidiary id from subsidiary reads."),
  country: countrySchema,
  currency: currencySchema,
  originatorSecrets: originatorSecretsSchema,
  settings: paymentProfileSettingsSchema,
  sftpServerId: uuidString().nullable().optional().describe("Optional active SFTP server id."),
  sftpFolder: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe("Optional remote folder for generated payment files."),
  autoRemittance: z
    .boolean()
    .optional()
    .describe("Whether remittance notices are sent automatically."),
  isActive: z.boolean().optional().describe("Whether payment runs may use this profile."),
});

export const paymentScheduleCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).describe("Operator-facing payment schedule name."),
  paymentBankProfileId: uuidString().describe(
    "Active credit-capable profile id from list_payment_operation_configs with resource profiles.",
  ),
  cron: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Cron expression controlling when the schedule runs."),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("IANA timezone used to evaluate the schedule; defaults to UTC."),
  selectionCriteria: selectionCriteriaSchema.optional(),
  action: z
    .enum(["create_draft", "submit_for_approval"])
    .optional()
    .describe("Whether each run creates a draft or submits it for approval."),
  isActive: z.boolean().optional().describe("Whether the schedule is eligible to run."),
});

export const paymentMandateCreateBodySchema = z.object({
  partyId: uuidString().describe("Customer party id from find_parties or get_record."),
  partyBankAccountId: uuidString().describe(
    "Approved customer bank account id from get_party_payment_setup.",
  ),
  mandateReference: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Reference supplied by the customer for this direct-debit mandate."),
  scheme: z
    .enum(["nacha", "sepa_core", "sepa_b2b", "custom"])
    .optional()
    .describe("Direct-debit scheme for this mandate."),
  status: z
    .enum(["pending", "active", "suspended", "revoked", "expired"])
    .optional()
    .describe("Initial mandate status; only active mandates are eligible for collection."),
  signedOn: calendarDateSchema.optional(),
  validFrom: calendarDateSchema.optional(),
  expiresOn: calendarDateSchema.optional(),
  proofFileId: uuidString().optional().describe("Optional proof file id from list_files."),
});

export const paymentOperationCreateBodySchema = z.union([
  paymentFormatCreateBodySchema,
  paymentProfileCreateBodySchema,
  paymentScheduleCreateBodySchema,
  paymentMandateCreateBodySchema,
]);

const paymentOperationPatchFields = {
  action: z
    .enum(["create_draft", "submit_for_approval"], {
      error: "action must be create_draft or submit_for_approval",
    })
    .optional()
    .describe("Whether scheduled runs create drafts or submit them for approval."),
  bankAccountId: uuidString().optional().describe("Replacement bank ledger account id."),
  contentType: z
    .string()
    .max(200)
    .optional()
    .describe("Replacement generated file MIME content type."),
  country: patchCountrySchema,
  cron: z.string().max(200).optional().describe("Replacement cron expression."),
  currency: patchCurrencySchema,
  expiresOn: datePatchSchema,
  fileExtension: z.string().max(20).optional().describe("Replacement generated file extension."),
  formatterScript: z.string().max(100000).optional().describe("Replacement formatter script."),
  isActive: z.boolean().optional().describe("Whether the configuration remains active."),
  name: z.string().max(200).optional().describe("Replacement operator-facing name."),
  paymentBankProfileId: uuidString().optional().describe("Replacement payment bank profile id."),
  paymentFormatId: uuidString().optional().describe("Replacement payment format id."),
  selectionCriteria: patchSelectionCriteriaSchema.optional(),
  settings: z
    .record(z.string(), z.json())
    .optional()
    .describe("Replacement JSON configuration settings."),
  originatorSecrets: originatorSecretsSchema,
  sftpServerId: uuidString()
    .nullable()
    .optional()
    .describe("Replacement SFTP server id, or null for manual delivery."),
  sftpFolder: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe("Replacement remote folder, or null to clear it."),
  autoRemittance: z
    .boolean()
    .optional()
    .describe("Whether remittance notices are sent automatically."),
  signedOn: datePatchSchema,
  status: z
    .enum(["pending", "active", "suspended", "revoked", "expired"], {
      error: "status must be pending, active, suspended, revoked, or expired",
    })
    .optional()
    .describe("Replacement mandate status."),
  subsidiaryId: uuidString()
    .nullable()
    .optional()
    .describe("Replacement subsidiary id, or null for organization-wide scope."),
  timezone: z.string().max(100).optional().describe("Replacement IANA timezone."),
  validFrom: datePatchSchema,
};

export const paymentOperationPatchBodySchema = z
  .object(paymentOperationPatchFields)
  .refine((body) => Object.keys(body).length > 0, "At least one payment setting is required");

export const paymentFormatPatchBodySchema = z.object({
  name: paymentOperationPatchFields.name,
  country: paymentOperationPatchFields.country,
  currency: paymentOperationPatchFields.currency,
  fileExtension: paymentOperationPatchFields.fileExtension,
  contentType: paymentOperationPatchFields.contentType,
  formatterScript: paymentOperationPatchFields.formatterScript,
  isActive: paymentOperationPatchFields.isActive,
});
export const paymentProfilePatchBodySchema = z.object({
  name: paymentOperationPatchFields.name,
  bankAccountId: paymentOperationPatchFields.bankAccountId,
  paymentFormatId: paymentOperationPatchFields.paymentFormatId,
  subsidiaryId: paymentOperationPatchFields.subsidiaryId,
  country: paymentOperationPatchFields.country,
  currency: paymentOperationPatchFields.currency,
  originatorSecrets: paymentOperationPatchFields.originatorSecrets,
  settings: paymentOperationPatchFields.settings,
  sftpServerId: paymentOperationPatchFields.sftpServerId,
  sftpFolder: paymentOperationPatchFields.sftpFolder,
  autoRemittance: paymentOperationPatchFields.autoRemittance,
  isActive: paymentOperationPatchFields.isActive,
});
export const paymentSchedulePatchBodySchema = z.object({
  name: paymentOperationPatchFields.name,
  paymentBankProfileId: paymentOperationPatchFields.paymentBankProfileId,
  cron: paymentOperationPatchFields.cron,
  timezone: paymentOperationPatchFields.timezone,
  selectionCriteria: paymentOperationPatchFields.selectionCriteria,
  action: paymentOperationPatchFields.action,
  isActive: paymentOperationPatchFields.isActive,
});
export const paymentMandatePatchBodySchema = z.object({
  status: paymentOperationPatchFields.status,
  signedOn: paymentOperationPatchFields.signedOn,
  validFrom: paymentOperationPatchFields.validFrom,
  expiresOn: paymentOperationPatchFields.expiresOn,
});
