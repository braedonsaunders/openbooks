import {
  holidayAssertionRouteHandlers,
  prepareHolidayAssertionRun,
  requestBodyInputSchema,
  requestBodySchema,
} from "../../app/api/payroll/runs/[id]/holiday-assertions/route";
import { ApplicationError, notFound } from "./errors";
import {
  assertPayrollActor,
  assertPayRunAccess,
  IDEMPOTENCY_KEY,
  payrollActor,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { z } from "zod";

const inputSchema = z.object({
  runDocumentId: UUID("Pay-run document id from list_pay_runs."),
  assertion: requestBodyInputSchema.describe(
    "One pack-declared holiday answer to file for this run.",
  ),
  idempotencyKey: IDEMPOTENCY_KEY,
});

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (response.ok) return payload as Record<string, unknown>;
  const details =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const message =
    typeof details.error === "string" ? details.error : "Payroll holiday assertion was refused.";
  if (response.status === 404) throw notFound("pay run");
  throw new ApplicationError(
    response.status === 403 ? "forbidden" : "invalid_input",
    message,
    response.status >= 400 && response.status < 500 ? response.status : 422,
    typeof details.remedy === "string" ? { remedy: details.remedy } : undefined,
  );
}

async function readAssertions(
  context: Parameters<typeof assertPayrollActor>[0],
  documentId: string,
) {
  const response = await holidayAssertionRouteHandlers.get!({
    request: new Request(`http://localhost/api/payroll/runs/${documentId}/holiday-assertions`),
    authz: context.authz,
    params: { id: documentId },
    body: undefined,
  });
  return readPayload(response);
}

export const PAYROLL_HOLIDAY_ASSERTION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_pay_run_holiday_assertions",
    title: "Get Pay Run Holiday Assertions",
    description:
      "Read the run roster, pack-declared holiday questions, filed answers, and entitlement-day evidence. Find the pay-run document id with list_pay_runs and use the returned employees and holiday keys when filing an answer.",
    inputSchema: z.object({ runDocumentId: UUID("Pay-run document id from list_pay_runs.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      await assertPayRunAccess(context, input.runDocumentId);
      return {
        ok: true,
        ...(await readAssertions(context, input.runDocumentId)),
        href: `/payroll/runs/${input.runDocumentId}?tab=holidays`,
      };
    },
  }),
  definition({
    name: "record_pay_run_holiday_assertion",
    title: "Record Pay Run Holiday Assertion",
    description:
      "File one employee's standing commission, occupation class, absence, or complete entitlement-day answer against an uncommitted pay run. Read get_pay_run_holiday_assertions first; verify the answer there before calculating the run.",
    inputSchema: inputSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.runDocumentId);
      const request = new Request(
        `http://localhost/api/payroll/runs/${input.runDocumentId}/holiday-assertions`,
        { headers: { "X-Request-Id": context.requestId } },
      );
      const refusal = await prepareHolidayAssertionRun(context.authz, input.runDocumentId, request);
      if (refusal) await readPayload(refusal);
      const assertion = requestBodySchema.parse(input.assertion);
      const result = await holidayAssertionRouteHandlers.post!({
        request,
        authz: context.authz,
        params: { id: input.runDocumentId },
        body: assertion,
      });
      const filed = await readPayload(result);
      return {
        ok: true,
        result: filed,
        state: await readAssertions(context, input.runDocumentId),
        href: `/payroll/runs/${input.runDocumentId}?tab=holidays`,
      };
    },
  }),
];
