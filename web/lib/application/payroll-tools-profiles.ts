import "server-only";
import { z } from "zod";
import {
  profileBodySchema,
  saveEmployeePayrollProfile,
} from "../../app/api/payroll/profiles/route";
import { notFound, ApplicationError } from "./errors";
import {
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  IDEMPOTENCY_KEY,
  payrollActor,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

function withFieldDescriptions<T extends z.ZodRawShape>(shape: T): T {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).describe(
        `Payroll profile ${key} value; follow the selected payroll pack contract.`,
      ),
    ]),
  ) as unknown as T;
}

const profileInputShape = profileBodySchema.omit({ sin: true }).shape;
const profileInputSchema = z
  .strictObject(
    withFieldDescriptions({
      ...profileInputShape,
      country: z
        .string()
        .max(3)
        .optional()
        .describe("Pack jurisdiction key supplied by the employee payroll read."),
      province: z
        .string()
        .max(80)
        .optional()
        .describe("Pack-recognized region supplied by payroll setup."),
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
      payScheduleId: UUID("Active pay schedule id from payroll setup reads."),
      filingAccountId: UUID("Payroll filing-account id from payroll setup reads.")
        .nullable()
        .optional(),
      workerCompGroupId: UUID("Worker-compensation group id from payroll setup reads.")
        .nullable()
        .optional(),
      expectedWorkerCompGroupId: UUID(
        "Expected worker-compensation group id for the audited update.",
      )
        .nullable()
        .optional(),
    }),
  )
  .extend({ idempotencyKey: IDEMPOTENCY_KEY });

function responseRefusal(response: Response, payload: unknown): never {
  const details =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const message =
    typeof details.error === "string" ? details.error : "Payroll profile save was refused.";
  if (response.status === 404) throw notFound("payroll profile");
  const code =
    response.status === 403 ? "forbidden" : response.status === 409 ? "conflict" : "invalid_input";
  throw new ApplicationError(
    code,
    message,
    response.status >= 400 && response.status < 500 ? response.status : 422,
    {
      ...(typeof details.field === "string" ? { field: details.field } : {}),
      ...(typeof details.remedy === "string" ? { remedy: details.remedy } : {}),
    },
  );
}

export const PAYROLL_PROFILE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "save_employee_payroll_profile",
    title: "Save Employee Payroll Profile",
    description:
      "Set an employee's payroll schedule, jurisdiction and pack-declared withholding elections, exemptions and delivery preferences. Find the employee and schedule ids with list_payroll_employees and payroll setup reads; verify the saved profile there. Taxpayer identifiers are not accepted or returned by this command.",
    inputSchema: profileInputSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      const { idempotencyKey, ...body } = input;
      const response = await saveEmployeePayrollProfile({
        request: new Request("http://localhost/api/payroll/profiles", {
          headers: { "X-Request-Id": idempotencyKey },
        }),
        authz: context.authz,
        body,
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) responseRefusal(response, payload);
      return {
        ok: true,
        employeePartyId: input.employeePartyId,
        href: `/payroll?employee=${input.employeePartyId}`,
      };
    },
  }),
];
