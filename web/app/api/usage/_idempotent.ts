import { randomUUID } from "node:crypto";
import { UsageBillingError } from "@openbooks/engine/src/billing/usage/errors.ts";
import { applicationContextFromSession } from "@/lib/application/context";
import { ApplicationError } from "@/lib/application/errors";
import { executeIdempotent } from "@/lib/application/idempotency";
import { created } from "@/lib/api/responses";
import type { Authz } from "@/lib/authz";

const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** Usage creates use the shared actor-scoped key ledger without changing engine create signatures. */
export async function idempotentUsageCreate<T extends Record<string, unknown>>(input: {
  request: Request;
  authz: Authz;
  operation: string;
  requestBody: unknown;
  execute: () => Promise<T>;
}): Promise<Response> {
  const key = input.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!KEY.test(key)) {
    return Response.json({
      error: "A valid Idempotency-Key header is required.",
      code: "invalid_idempotency_key",
      remedy: "Retry the create with a new key containing 8 to 200 letters, numbers, or . _ : - characters.",
    }, { status: 400 });
  }
  try {
    const outcome = await executeIdempotent({
      context: applicationContextFromSession(input.authz, "api", randomUUID()),
      operation: input.operation,
      idempotencyKey: key,
      request: input.requestBody,
      execute: input.execute,
      successStatus: () => 201,
    });
    return created(outcome.value);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "conflict") {
      throw new UsageBillingError(
        "idempotency_key_conflict",
        "This Idempotency-Key was already used with different details.",
        "Retry the create with the intended details and a new Idempotency-Key.",
        { status: 409 },
      );
    }
    throw error;
  }
}
