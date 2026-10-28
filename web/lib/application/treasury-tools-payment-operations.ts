import "server-only";
import { z } from "zod";
import { can } from "../authz";
import {
  listPaymentOperationConfigs,
  PaymentOperationManagementError,
} from "../payment-operations-management";
import type { PaymentOperationResource } from "../payment-operations-management";
import { loadPartyDebitMandates } from "../party-debit-mandates";
import {
  paymentFormatCreateBodySchema,
  paymentFormatPatchBodySchema,
  paymentMandateCreateBodySchema,
  paymentMandatePatchBodySchema,
  paymentProfileCreateBodySchema,
  paymentProfilePatchBodySchema,
  paymentScheduleCreateBodySchema,
  paymentSchedulePatchBodySchema,
} from "../payment-operation-schemas";
import { ApplicationError, conflict, notFound } from "./errors";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { IDEMPOTENCY_KEY, UUID, settleDomainRefusal } from "./treasury-tools-common";
import {
  createPaymentFormatRecord,
  createPaymentMandateRecord,
  createPaymentProfileRecord,
  createPaymentScheduleRecord,
  updatePaymentFormatRecord,
  updatePaymentMandateRecord,
  updatePaymentProfileRecord,
  updatePaymentScheduleRecord,
  type PaymentOperationInput,
} from "../payment-operations-management";

const resourceSchema = z
  .enum(["formats", "profiles", "schedules", "mandates"])
  .describe("Configuration group to read.");

const customFormatCreateSchema = paymentFormatCreateBodySchema.extend({
  idempotencyKey: IDEMPOTENCY_KEY,
});
const paymentProfileCreateSchema = paymentProfileCreateBodySchema.extend({
  idempotencyKey: IDEMPOTENCY_KEY,
});
const paymentScheduleCreateSchema = paymentScheduleCreateBodySchema.extend({
  idempotencyKey: IDEMPOTENCY_KEY,
});
const paymentMandateCreateSchema = paymentMandateCreateBodySchema.extend({
  idempotencyKey: IDEMPOTENCY_KEY,
});
const formatPatchSchema = paymentFormatPatchBodySchema
  .extend({
    id: UUID.describe("Custom payment format id from list_payment_operation_configs."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine((body) =>
    Object.keys(body).some((field) => field !== "id" && field !== "idempotencyKey"),
  );
const profilePatchSchema = paymentProfilePatchBodySchema
  .extend({
    id: UUID.describe("Payment bank profile id from list_payment_operation_configs."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine((body) =>
    Object.keys(body).some((field) => field !== "id" && field !== "idempotencyKey"),
  );
const schedulePatchSchema = paymentSchedulePatchBodySchema
  .extend({
    id: UUID.describe("Payment schedule id from list_payment_operation_configs."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine((body) =>
    Object.keys(body).some((field) => field !== "id" && field !== "idempotencyKey"),
  );
const mandatePatchSchema = paymentMandatePatchBodySchema
  .extend({
    id: UUID.describe(
      "Payment mandate id from list_payment_operation_configs or get_party_payment_setup.",
    ),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine((body) =>
    Object.keys(body).some((field) => field !== "id" && field !== "idempotencyKey"),
  );

function hrefFor(resource: PaymentOperationResource, id: string, row: Record<string, unknown>) {
  if (resource === "mandates" && typeof row.party_id === "string") {
    return `/parties?party=${encodeURIComponent(row.party_id)}&partyTab=accounting`;
  }
  return `/admin/setup/payment-operations?view=${resource}&row=${encodeURIComponent(id)}`;
}

function statusFor(row: Record<string, unknown>): string {
  if (typeof row.status === "string") return row.status;
  return row.is_active === false ? "inactive" : "active";
}

async function configRecord(
  context: ApplicationContext,
  resource: PaymentOperationResource,
  id: string,
) {
  const result = await listPaymentOperationConfigs(resource, { authz: context.authz });
  const row = (result.rows as Record<string, unknown>[]).find((candidate) => candidate.id === id);
  if (!row) throw notFound("payment operation configuration");
  return row;
}

function operationContext(context: ApplicationContext) {
  return { authz: context.authz, requestId: context.requestId };
}

function inputWithoutIdempotencyKey(input: object): PaymentOperationInput {
  const { idempotencyKey: _idempotencyKey, ...payload } = input as Record<string, unknown>;
  return payload as PaymentOperationInput;
}

function settlePaymentOperationError(error: unknown): never {
  if (error instanceof PaymentOperationManagementError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (error.status === 409) throw conflict(error.message);
    throw new ApplicationError("invalid_input", error.message, error.status);
  }
  settleDomainRefusal(error, 422);
}

async function configResult(
  context: ApplicationContext,
  resource: PaymentOperationResource,
  id: string,
) {
  const record = await configRecord(context, resource, id);
  return {
    ok: true,
    id,
    status: statusFor(record),
    record,
    href: hrefFor(resource, id, record),
  };
}

async function createMandateResult(context: ApplicationContext, id: string, partyId: string) {
  const result = await loadPartyDebitMandates(
    context.authz.user.orgId,
    partyId,
    context.authz.allowedSubsidiaryIds,
  );
  const record = result?.mandates.find((mandate) => mandate.id === id);
  if (!record) throw notFound("payment mandate");
  return {
    ok: true,
    id,
    status: record.status,
    record,
    href: `/parties?party=${encodeURIComponent(partyId)}&partyTab=accounting`,
  };
}

export const TREASURY_PAYMENT_OPERATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_payment_operation_configs",
    title: "List Payment Operation Configurations",
    description:
      "List payment formats, bank profiles, schedules, or mandates visible to the caller. Use the returned ids with the matching create or update workflow; mandate bank-account choices come from get_party_payment_setup.",
    inputSchema: z.object({ resource: resourceSchema }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      return listPaymentOperationConfigs(input.resource, { authz: context.authz });
    },
  }),
  definition({
    name: "get_party_payment_setup",
    title: "Get Party Payment Setup",
    description:
      "Read a customer's direct-debit mandates and approved bank accounts that may be used for a mandate. Find the party id with find_parties; the drawer path opens the party's accounting tab.",
    inputSchema: z.object({
      partyId: UUID.describe("Customer party id from find_parties or get_record."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const result = await loadPartyDebitMandates(
        context.authz.user.orgId,
        input.partyId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!result) throw notFound("party");
      return {
        ...result,
        partyId: input.partyId,
        href: `/parties?party=${encodeURIComponent(input.partyId)}&partyTab=accounting`,
      };
    },
  }),
  definition({
    name: "create_payment_format",
    title: "Create Payment Format",
    description:
      "Create a custom bank-file format for payment profiles. Then use list_payment_operation_configs with resource formats to verify the format and obtain its id.",
    inputSchema: customFormatCreateSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const payload = inputWithoutIdempotencyKey(input);
      try {
        const { id } = await createPaymentFormatRecord(operationContext(context), payload);
        return await configResult(context, "formats", id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "create_payment_bank_profile",
    title: "Create Payment Bank Profile",
    description:
      "Create a bank profile that connects an active bank ledger account to a payment format. Use list_payment_operation_configs to find the format and verify the profile; secret values are not returned by reads.",
    inputSchema: paymentProfileCreateSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const payload = inputWithoutIdempotencyKey(input);
      try {
        const profile = await createPaymentProfileRecord(operationContext(context), payload);
        return await configResult(context, "profiles", profile.id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "create_payment_schedule",
    title: "Create Payment Schedule",
    description:
      "Create a recurring payment schedule for an active credit-capable bank profile. Use list_payment_operation_configs to find the profile id and verify the schedule.",
    inputSchema: paymentScheduleCreateSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const payload = inputWithoutIdempotencyKey(input);
      try {
        const { id } = await createPaymentScheduleRecord(operationContext(context), payload);
        return await configResult(context, "schedules", id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "create_payment_mandate",
    title: "Create Payment Mandate",
    description:
      "Create a direct-debit mandate for an active customer using an approved bank account. Find the party with find_parties, then use get_party_payment_setup to choose its bank-account id and verify the mandate.",
    inputSchema: paymentMandateCreateSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const payload = inputWithoutIdempotencyKey(input);
      try {
        const { id } = await createPaymentMandateRecord(operationContext(context), payload);
        return await createMandateResult(context, id, input.partyId);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "update_payment_format",
    title: "Update Payment Format",
    description:
      "Update a custom payment format while it is editable; built-in formats are read-only. Find its id with list_payment_operation_configs using resource formats, then verify the saved record there.",
    inputSchema: formatPatchSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const { id, ...fields } = input;
      try {
        await updatePaymentFormatRecord(
          operationContext(context),
          id,
          inputWithoutIdempotencyKey(fields),
        );
        return await configResult(context, "formats", id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "update_payment_bank_profile",
    title: "Update Payment Bank Profile",
    description:
      "Update a payment bank profile's account, format, currency, delivery, or secret settings. Find its id with list_payment_operation_configs using resource profiles; credentials remain encrypted and are not returned.",
    inputSchema: profilePatchSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const { id, ...fields } = input;
      try {
        await updatePaymentProfileRecord(
          operationContext(context),
          id,
          inputWithoutIdempotencyKey(fields),
        );
        return await configResult(context, "profiles", id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "update_payment_schedule",
    title: "Update Payment Schedule",
    description:
      "Update a payment schedule's cadence, selection limits, profile, action, or active state. Find its id with list_payment_operation_configs using resource schedules and verify the saved record there.",
    inputSchema: schedulePatchSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const { id, ...fields } = input;
      try {
        await updatePaymentScheduleRecord(
          operationContext(context),
          id,
          inputWithoutIdempotencyKey(fields),
        );
        return await configResult(context, "schedules", id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
  definition({
    name: "update_payment_mandate",
    title: "Update Payment Mandate",
    description:
      "Update a party's mandate status or effective dates while preserving its party and bank-account binding. Find the mandate id with get_party_payment_setup or list_payment_operation_configs, then verify it through the party setup read.",
    inputSchema: mandatePatchSchema,
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const { id, ...fields } = input;
      try {
        await updatePaymentMandateRecord(
          operationContext(context),
          id,
          inputWithoutIdempotencyKey(fields),
        );
        const row = await configRecord(context, "mandates", id);
        if (typeof row.party_id !== "string") throw notFound("payment mandate");
        return await createMandateResult(context, id, row.party_id);
      } catch (error) {
        settlePaymentOperationError(error);
      }
    },
  }),
];
