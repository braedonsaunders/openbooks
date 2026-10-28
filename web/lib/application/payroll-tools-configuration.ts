import "server-only";
import { z } from "zod";
import {
  packActionSchema,
  payrollSettingsSchema,
  performPayrollPackAction,
  savePayrollSettings,
} from "../../app/api/payroll/settings/route";
import {
  requestBodySchema as employerFactBodySchema,
  savePayrollEmployerFact,
} from "../../app/api/payroll/settings/employer-facts/route";
import {
  requestBodySchema as statutoryRateBodySchema,
  savePayrollStatutoryRate,
  retirePayrollStatutoryRate,
} from "../../app/api/payroll/settings/rates/route";
import { listPayrollEmployerFacts } from "@openbooks/engine/payroll/employer-fact-store";
import { listStatutoryRates } from "@openbooks/engine/payroll/statutory-rates";
import {
  assertPayrollActor,
  assertPayrollRootScope,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  UUID,
} from "./payroll-tools-common";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json().catch(() => ({}));
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (response.ok) return body;
  const message =
    typeof body.error === "string" ? body.error : "Payroll configuration change was refused.";
  if (response.status === 404) throw notFound("payroll configuration");
  const code =
    response.status === 403 ? "forbidden" : response.status === 409 ? "conflict" : "invalid_input";
  throw new ApplicationError(
    code,
    message,
    response.status >= 400 && response.status < 500 ? response.status : 422,
    {
      ...(typeof body.field === "string" ? { field: body.field } : {}),
      ...(typeof body.remedy === "string" ? { remedy: body.remedy } : {}),
    },
  );
}

function parseNative<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw invalidInput(error.issues[0]?.message ?? "Payroll configuration is invalid.");
    throw error;
  }
}

async function runPackAction(
  context: Parameters<typeof assertPayrollActor>[0],
  action: z.infer<typeof packActionSchema>["action"],
  country: string,
) {
  await assertPayrollActor(context, "payroll.manage");
  await assertPayrollRootScope(context);
  const body = parseNative(packActionSchema, { action, country });
  const response = await performPayrollPackAction({ authz: context.authz, body });
  const payload = await readResponse(response);
  return { ok: true, ...payload, href: "/admin/setup/payroll" };
}

export const PAYROLL_CONFIGURATION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_payroll_employer_facts",
    title: "List Payroll Employer Facts",
    description:
      "Read effective-dated employer answers declared by installed payroll packs. Use the rows and pack declaration from payroll setup reads to select a fact key and legal employer or filing account.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .optional()
        .describe("Filter by an installed pack key from payroll setup."),
      subsidiaryId: UUID("Filter by a legal-employer id from payroll setup.").optional(),
      filingAccountId: UUID("Filter by a payroll filing-account id from payroll setup.").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const rows = await listPayrollEmployerFacts(context.authz.user.orgId, input);
      return { ok: true, rows, href: "/admin/setup/payroll?tab=employer-facts" };
    },
  }),
  definition({
    name: "update_payroll_employer_fact",
    title: "Update Payroll Employer Fact",
    description:
      "Save an effective-dated employer fact declared by an installed payroll pack at the organization root. Find the pack key, fact key, scope, legal employer or filing account with list_payroll_employer_facts and verify the saved row there.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .describe("Installed pack key supplied by payroll setup."),
      factKey: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Employer fact key declared by the selected pack."),
      subsidiaryId: UUID("Legal-employer id when the fact is employer-scoped.")
        .nullable()
        .optional(),
      filingAccountId: UUID("Filing-account id when the fact is filing-account-scoped.")
        .nullable()
        .optional(),
      effectiveFrom: DATE.describe("First date the fact applies."),
      effectiveThrough: DATE.nullable()
        .optional()
        .describe("Last date the fact applies, or null for no scheduled end."),
      value: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Value accepted by the pack's declared employer-fact contract."),
      changeReason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason retained in the employer-fact audit."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const { idempotencyKey: _key, ...raw } = input;
      const body = parseNative(employerFactBodySchema, raw);
      const response = await savePayrollEmployerFact({ authz: context.authz, body });
      const result = await readResponse(response);
      return { ok: true, row: result.row, href: "/admin/setup/payroll?tab=employer-facts" };
    },
  }),
  definition({
    name: "list_payroll_statutory_rates",
    title: "List Payroll Statutory Rates",
    description:
      "Read active or historical statutory rates saved for installed payroll packs. Find rate ids, scope points, values and source citations here before updating or retiring a rate.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .optional()
        .describe("Filter by a pack key from payroll setup."),
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Filter by the statutory year declared by the pack."),
      includeSuperseded: z
        .boolean()
        .optional()
        .describe("Include superseded rate history when reviewing changes."),
      asOf: DATE.optional().describe("Keep rates that were in force on this date."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const rows = await listStatutoryRates(context.authz.user.orgId, input);
      return { ok: true, rows, href: "/admin/setup/payroll?tab=statutory-rates" };
    },
  }),
  definition({
    name: "update_payroll_statutory_rate",
    title: "Update Payroll Statutory Rate",
    description:
      "Save a dated statutory rate at a scope point declared by an installed payroll pack, with source citation and change reason. Use list_payroll_statutory_rates and payroll setup to find the pack slot, region, year and filing account, then verify the saved rate there.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .describe("Installed pack key supplied by payroll setup."),
      rateKey: z.string().trim().min(1).max(120).describe("Pack-declared statutory-rate slot key."),
      region: z
        .string()
        .trim()
        .max(80)
        .nullable()
        .optional()
        .describe("Pack-declared region for this rate scope."),
      subRegion: z
        .string()
        .trim()
        .max(120)
        .nullable()
        .optional()
        .describe("Pack-declared subregion for this rate scope."),
      filingAccountId: UUID("Filing-account id when the pack scopes this rate by account.")
        .nullable()
        .optional(),
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .describe("Tax year for the dated statutory rate."),
      values: z
        .record(
          z.string().describe("Field declared by the selected rate slot."),
          z
            .union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.boolean()])
            .describe("Exact decimal text or pack-declared boolean flag."),
        )
        .describe("Values for the selected pack-declared rate slot."),
      sourceCitation: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Official source or notice citation for this rate."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for recording or changing the rate."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const { idempotencyKey: _key, ...raw } = input;
      const body = parseNative(statutoryRateBodySchema, raw);
      const response = await savePayrollStatutoryRate({ authz: context.authz, body });
      const result = await readResponse(response);
      return { ok: true, ...result, href: "/admin/setup/payroll?tab=statutory-rates" };
    },
  }),
  definition({
    name: "retire_payroll_statutory_rate",
    title: "Retire Payroll Statutory Rate",
    description:
      "Retire a current statutory-rate row by its id so prior periods retain the old value. Find the rate id with list_payroll_statutory_rates and verify the row is superseded there.",
    inputSchema: z.object({
      id: UUID("Statutory-rate row id from list_payroll_statutory_rates."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const response = await retirePayrollStatutoryRate({ authz: context.authz, id: input.id });
      await readResponse(response);
      return { ok: true, id: input.id, href: "/admin/setup/payroll?tab=statutory-rates" };
    },
  }),
  definition({
    name: "update_payroll_settings",
    title: "Update Payroll Settings",
    description:
      "Update payroll accounts, pack-declared remittance settings, delivery policies, and calculation preferences at the organization root. Read payroll_setup_status and payroll setup records first, then verify the saved configuration there.",
    inputSchema: z.object({
      settings: z
        .record(
          z.string().describe("Payroll setting key declared by the setup contract."),
          z.unknown().describe("Setting value validated by the payroll setup contract."),
        )
        .describe("Settings to update, using only keys from payroll setup reads."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollRootScope(context);
      const body = parseNative(payrollSettingsSchema, input.settings);
      const response = await savePayrollSettings({ authz: context.authz, body });
      await readResponse(response);
      return { ok: true, href: "/admin/setup/payroll" };
    },
  }),
  definition({
    name: "install_payroll_pack",
    title: "Install Payroll Pack",
    description:
      "Install the selected versioned payroll pack and its required statutory components at the organization root. Use the pack choices shown by payroll setup reads and verify the installed pack in payroll_setup_status.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .describe(
          "Pack key from payroll setup; pass it through without interpreting jurisdiction.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => runPackAction(context, "install-pack", input.country),
  }),
  definition({
    name: "seed_payroll_pack_components",
    title: "Seed Payroll Pack Components",
    description:
      "Seed the required statutory pay components for an already configured payroll pack. Select an installable pack from payroll setup reads and verify the components there.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .describe(
          "Installable pack key from payroll setup; pass it through without interpreting jurisdiction.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => runPackAction(context, "seed-components", input.country),
  }),
  definition({
    name: "uninstall_payroll_pack",
    title: "Uninstall Payroll Pack",
    description:
      "Remove an installed payroll pack only when its native uninstall checks permit it; historical payroll records remain governed by their own pack evidence. Find the pack in payroll_setup_status and verify the updated installed-pack list there.",
    inputSchema: z.object({
      country: z
        .string()
        .trim()
        .min(2)
        .max(3)
        .describe(
          "Installed pack key from payroll_setup_status; pass it through without interpreting jurisdiction.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => runPackAction(context, "uninstall-pack", input.country),
  }),
];
