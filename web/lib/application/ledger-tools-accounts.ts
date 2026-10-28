import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { withOrg } from "@openbooks/engine/platform/db";
import { createAccountAction, createAccountBodySchema } from "../accounts/create-action";
import {
  hasAccountUpdateField,
  updateAccountAction,
  updateAccountFields,
} from "../accounts/update-action";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by the account register.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const CREATE_KEY = IDEMPOTENCY_KEY.describe("Unique retry key for this exact account create.");

function routeErrorCode(status: number): ConstructorParameters<typeof ApplicationError>[0] {
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "internal_error";
}

async function accountResult(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const details = {
      ...(body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? (body.details as Record<string, unknown>)
        : {}),
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(typeof body.field === "string" ? { field: body.field } : {}),
      ...(typeof body.remedy === "string" ? { remedy: body.remedy } : {}),
    };
    throw new ApplicationError(
      routeErrorCode(response.status),
      typeof body.error === "string" ? body.error : "Account change was refused.",
      response.status,
      details,
    );
  }

  const payload = body as {
    account?: { id?: unknown; is_active?: unknown };
  };
  const accountId = payload.account?.id;
  if (typeof accountId !== "string") {
    throw new ApplicationError("internal_error", "Account change returned no account id.", 500);
  }
  return {
    ok: true,
    ...body,
    accountId,
    status: payload.account?.is_active === false ? "inactive" : "active",
    href: `/accounts?account=${encodeURIComponent(accountId)}`,
  };
}

function routeRequest(idempotencyKey: string, create = false): Request {
  let routeKey = idempotencyKey;
  if (create) {
    const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
    routeKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return new Request("http://openbooks.local/api/accounts", {
    headers: { "Idempotency-Key": routeKey },
  });
}

async function executeAccountAction(
  context: ApplicationContext,
  action: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  assertApplicationPermission(context, "gl.manage");
  return withOrg(context.authz.user.orgId, async () => accountResult(await action()));
}

export const LEDGER_ACCOUNT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_chart_account",
    title: "Create Chart Account",
    description:
      "Create an account in the chart of accounts when the account register does not already contain it. Use list_records with typeKey accounts to check account ids and existing names first.",
    inputSchema: createAccountBodySchema.extend({ idempotencyKey: CREATE_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "gl.manage"),
    authorizeReplay: async (context) => assertApplicationPermission(context, "gl.manage"),
    execute: async (context, input) => {
      const { idempotencyKey, ...body } = input;
      return executeAccountAction(context, () =>
        createAccountAction({
          request: routeRequest(idempotencyKey, true),
          authz: context.authz,
          body,
        }),
      );
    },
  }),
  definition({
    name: "update_chart_account",
    title: "Update Chart Account",
    description:
      "Edit an existing chart account while it remains in the caller's subsidiary scope. Find the account id and current values with list_records or get_record using typeKey accounts.",
    inputSchema: z
      .strictObject({
        ...updateAccountFields,
        accountId: UUID,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (body) => hasAccountUpdateField(body, ["accountId", "idempotencyKey"]),
        "provide at least one account field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "gl.manage"),
    authorizeReplay: async (context) => assertApplicationPermission(context, "gl.manage"),
    execute: async (context, input) => {
      const { idempotencyKey, accountId, ...body } = input;
      return executeAccountAction(context, () =>
        updateAccountAction({
          request: routeRequest(idempotencyKey),
          authz: context.authz,
          params: { id: accountId },
          body,
        }),
      );
    },
  }),
];
