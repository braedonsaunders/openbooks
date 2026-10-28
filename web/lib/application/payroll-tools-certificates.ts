import { z } from "zod";
import {
  certificateBodySchema,
  certificateRouteHandlers,
  correctionSchema,
  voidSchema,
} from "../../app/api/payroll/certificates/route";
import { ApplicationError, notFound } from "./errors";
import {
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

function describeFields<T extends z.ZodRawShape>(shape: T): T {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).describe(`Pack-declared employee certificate ${key}.`),
    ]),
  ) as unknown as T;
}

const certificateInput = z
  .strictObject({
    ...describeFields(certificateBodySchema.shape),
    country: z
      .string()
      .min(1)
      .max(3)
      .describe("Pack jurisdiction key from the employee's profile."),
    certificateKey: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Certificate key declared by the selected payroll pack."),
    effectiveFrom: z
      .union([z.literal(""), DATE])
      .nullable()
      .optional()
      .describe("Effective date for this certificate, or blank when the pack selects it."),
    answers: z
      .record(
        z.string().min(1).describe("Field key declared by the selected payroll pack certificate."),
        z
          .string()
          .describe(
            "Answer for the declared certificate field; never include taxpayer identifiers.",
          ),
      )
      .describe("Pack-declared employee certificate field answers."),
  })
  .extend({ idempotencyKey: IDEMPOTENCY_KEY });
const correctionInput = z
  .strictObject({
    ...describeFields(correctionSchema.shape),
    effectiveFrom: DATE.describe("Corrected effective date for this filing."),
    employeePartyId: UUID("Employee party id shown by list_employee_payroll_certificates."),
  })
  .extend({ idempotencyKey: IDEMPOTENCY_KEY });
const voidInput = z
  .strictObject({
    ...describeFields(voidSchema.shape),
    employeePartyId: UUID("Employee party id shown by list_employee_payroll_certificates."),
  })
  .extend({ idempotencyKey: IDEMPOTENCY_KEY });
const employeeInput = z.object({
  employeePartyId: UUID("Employee party id from payroll employee reads."),
});

async function readCertificateState(
  context: Parameters<NonNullable<typeof certificateRouteHandlers.get>>[0]["authz"],
  employeePartyId: string,
) {
  const response = await certificateRouteHandlers.get!({
    request: new Request(
      `http://localhost/api/payroll/certificates?employee=${encodeURIComponent(employeePartyId)}`,
    ),
    authz: context,
    params: undefined,
    body: undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) responseRefusal(response, payload);
  return payload;
}

function responseRefusal(response: Response, payload: Record<string, unknown>): never {
  const message =
    typeof payload.error === "string" ? payload.error : "Payroll certificate request was refused.";
  if (response.status === 404) throw notFound("payroll certificate");
  const code =
    response.status === 403 ? "forbidden" : response.status === 409 ? "conflict" : "invalid_input";
  throw new ApplicationError(
    code,
    message,
    response.status >= 400 && response.status < 500 ? response.status : 422,
    {
      ...(typeof payload.remedy === "string" ? { remedy: payload.remedy } : {}),
      ...(typeof payload.field === "string" ? { field: payload.field } : {}),
    },
  );
}

function parseNativeBody<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ApplicationError(
        "invalid_input",
        error.issues[0]?.message ?? "Invalid certificate input.",
        422,
      );
    throw error;
  }
}

async function invokeMutation(
  handler:
    | NonNullable<typeof certificateRouteHandlers.post>
    | NonNullable<typeof certificateRouteHandlers.patch>
    | NonNullable<typeof certificateRouteHandlers.delete>,
  context: Parameters<NonNullable<typeof certificateRouteHandlers.get>>[0]["authz"],
  requestId: string,
  body: unknown,
) {
  const response = await handler({
    request: new Request("http://localhost/api/payroll/certificates", {
      headers: { "X-Request-Id": requestId },
    }),
    authz: context,
    params: undefined,
    body,
  } as never);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) responseRefusal(response, payload);
  return payload;
}

export const PAYROLL_CERTIFICATE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_employee_payroll_certificates",
    title: "List Employee Payroll Certificates",
    description:
      "Read the pack-declared employee certificate forms and effective-dated filings. Find the employee id with payroll employee reads; the command returns available pack declarations and current filing history without taxpayer identifiers.",
    inputSchema: employeeInput,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      return {
        ok: true,
        ...(await readCertificateState(context.authz, input.employeePartyId)),
        href: `/payroll/certificates?employee=${input.employeePartyId}`,
      };
    },
  }),
  definition({
    name: "file_employee_payroll_certificate",
    title: "File Employee Payroll Certificate",
    description:
      "File answers to a row-backed withholding certificate declared by the employee's active payroll pack. Read list_employee_payroll_certificates first for valid form and field keys, then verify the effective-dated filing there.",
    inputSchema: certificateInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      const { idempotencyKey: _key, ...body } = input;
      const result = await invokeMutation(
        certificateRouteHandlers.post!,
        context.authz,
        context.requestId,
        parseNativeBody(certificateBodySchema, body),
      );
      return {
        ok: true,
        ...result,
        state: await readCertificateState(context.authz, input.employeePartyId),
        href: `/payroll/certificates?employee=${input.employeePartyId}`,
      };
    },
  }),
  definition({
    name: "correct_employee_payroll_certificate",
    title: "Correct Employee Payroll Certificate",
    description:
      "Correct the effective date of an unused certificate filing while preserving the audited history. Read list_employee_payroll_certificates to find the filing id and interval; committed payroll history cannot be changed.",
    inputSchema: correctionInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      const { idempotencyKey: _key, employeePartyId, ...body } = input;
      const result = await invokeMutation(
        certificateRouteHandlers.patch!,
        context.authz,
        context.requestId,
        parseNativeBody(correctionSchema, body),
      );
      return {
        ok: true,
        ...result,
        state: await readCertificateState(context.authz, employeePartyId),
        href: `/payroll/certificates?employee=${employeePartyId}`,
      };
    },
  }),
  definition({
    name: "void_employee_payroll_certificate",
    title: "Void Employee Payroll Certificate",
    description:
      "Void the currently effective certificate filing with an audit reason; its answers remain available for historical payroll. Read list_employee_payroll_certificates first to find the filing id and verify the closed interval afterward.",
    inputSchema: voidInput,
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      const { idempotencyKey: _key, employeePartyId, ...body } = input;
      const result = await invokeMutation(
        certificateRouteHandlers.delete!,
        context.authz,
        context.requestId,
        parseNativeBody(voidSchema, body),
      );
      return {
        ok: true,
        ...result,
        state: await readCertificateState(context.authz, employeePartyId),
        href: `/payroll/certificates?employee=${employeePartyId}`,
      };
    },
  }),
];
