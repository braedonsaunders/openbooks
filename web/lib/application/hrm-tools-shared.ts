import "server-only";
import { z, type ZodObject, type ZodRawShape } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { HrmAuthorizationError } from "@openbooks/engine/hrm/authorization";
import { HrmConstructionError } from "@openbooks/engine/hrm/construction";
import { UnrestrictedScopeError } from "@openbooks/engine/organization/scope";
import { isMaskedFileContentError } from "@openbooks/engine/platform/file-storage";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

export const HRM_UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a native HRM read result; never invent one.");
export const HRM_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const HRM_IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

/** Preserve a route's validators while ensuring each exposed input has a provider-visible description. */
export function describeObjectFields<T extends ZodRawShape>(
  schema: ZodObject<T>,
  describeField: (key: string) => string = (key) =>
    `Value for ${key} as required by the native HRM contract.`,
): ZodObject<T> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, field.describe(describeField(key))]),
  ) as T;
  return schema.extend(shape);
}

type Permission = string | readonly string[];

export function settleHrmRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof UnrestrictedScopeError) {
    throw new ApplicationError("forbidden", error.message, 403);
  }
  if (isMaskedFileContentError(error)) {
    throw new ApplicationError("forbidden", (error as Error).message, 403);
  }
  if (error instanceof HrmAuthorizationError) {
    if (/not visible in this organization/i.test(error.message)) {
      throw new ApplicationError("not_found", error.message, 404);
    }
    throw new ApplicationError("forbidden", error.message, 403);
  }
  if (error instanceof HrmConstructionError) {
    const message = error.message;
    const status = /must be|Unknown|needs|at least|shape|blank/i.test(message)
      ? 400
      : /does not exist|no longer|not exist here|no .* policy|cannot be read back/i.test(message)
        ? 404
        : 422;
    throw new ApplicationError(status === 404 ? "not_found" : "invalid_input", message, status);
  }
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = String(error.code).toLowerCase();
    const message = typeof error.message === "string" ? error.message : "HRM operation refused";
    const details: Record<string, unknown> = {};
    if ("field" in error && typeof error.field === "string") details.field = error.field;
    if ("issues" in error && Array.isArray(error.issues))
      details.issues = error.issues.slice(0, 20);
    if (code === "not_found" || code === "feature_off") {
      throw new ApplicationError("not_found", message, 404, details);
    }
    if (code === "forbidden" || code === "unauthorized") {
      throw new ApplicationError(
        code === "unauthorized" ? "unauthorized" : "forbidden",
        message,
        code === "unauthorized" ? 401 : 403,
        details,
      );
    }
    if (
      code === "bad_state" ||
      code === "stale_revision" ||
      code.startsWith("stale_") ||
      code === "duplicate_open" ||
      code === "duplicate" ||
      code === "conflict"
    ) {
      throw conflict(message, details);
    }
    if (code === "template_not_found" && error.constructor.name === "HrmPerformanceError") {
      throw new ApplicationError("not_found", message, 404, details);
    }
    if (
      code.startsWith("invalid") ||
      code.startsWith("unknown") ||
      code === "validation" ||
      code === "refused" ||
      code === "no_flow" ||
      code === "flow_error" ||
      code === "evidence_required" ||
      code === "unreadable_attachment" ||
      code === "template_not_found" ||
      code === "ambiguous_template" ||
      code === "no_live_version" ||
      code === "no_required_question" ||
      code === "requires_reapproval" ||
      code === "over_filled" ||
      code === "under_funded"
    ) {
      const status =
        code === "validation" || code.startsWith("invalid") || code.startsWith("unknown")
          ? 400
          : 422;
      throw new ApplicationError("invalid_input", message, status, details);
    }
  }
  throw error;
}

interface MutationSpec<T extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: ZodObject<T>;
  permission: Permission;
  featureKey: string;
  destructive?: boolean;
  openWorld?: boolean;
  execute: (
    context: ApplicationContext,
    input: z.infer<ZodObject<T>> & { idempotencyKey: string },
  ) => Promise<Record<string, unknown>>;
}

interface ReadSpec<T extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: ZodObject<T>;
  permission: Permission;
  featureKey: string;
  openWorld?: boolean;
  execute: (
    context: ApplicationContext,
    input: z.infer<ZodObject<T>>,
  ) => Promise<Record<string, unknown>>;
}

function permissionsFor(permission: Permission): readonly string[] {
  return typeof permission === "string" ? [permission] : permission;
}

function permissionVisible(authz: Authz, permissions: readonly string[]): boolean {
  return permissions.some((permission) => can(authz, permission));
}

function requireVisiblePermission(
  context: ApplicationContext,
  permissions: readonly string[],
): void {
  if (!permissionVisible(context.authz, permissions)) {
    throw forbidden(permissions.length === 1 ? permissions[0]! : permissions.join(" or "));
  }
  const permission = permissions.find((candidate) => can(context.authz, candidate));
  if (permission) assertApplicationPermission(context, permission);
}

async function requireHrmFeature(orgId: string, featureKey: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, featureKey))) throw notFound("HRM feature");
}

export function hrmRead<T extends ZodRawShape>(spec: ReadSpec<T>): ApplicationToolDefinition {
  const permissions = permissionsFor(spec.permission);
  const visibleTo = (authz: Authz) => permissionVisible(authz, permissions);
  return definition({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.input,
    readOnly: true,
    destructive: false,
    openWorld: spec.openWorld ?? false,
    assistantConfirmation: "never",
    featureKey: spec.featureKey,
    visibleTo,
    execute: async (context, input) => {
      requireVisiblePermission(context, permissions);
      try {
        await requireHrmFeature(context.authz.user.orgId, spec.featureKey);
        return await spec.execute(context, input);
      } catch (error) {
        settleHrmRefusal(error);
      }
    },
  });
}

export function hrmMutation<T extends ZodRawShape>(
  spec: MutationSpec<T>,
): ApplicationToolDefinition {
  const permissions = permissionsFor(spec.permission);
  const visibleTo = (authz: Authz) => permissions.some((permission) => can(authz, permission));
  return definition({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.input.extend({ idempotencyKey: HRM_IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: spec.destructive ?? false,
    openWorld: spec.openWorld ?? false,
    assistantConfirmation: "always",
    featureKey: spec.featureKey,
    visibleTo,
    authorizeReplay: async (context) => {
      requireVisiblePermission(context, permissions);
      await requireHrmFeature(context.authz.user.orgId, spec.featureKey);
    },
    execute: async (context, input) => {
      requireVisiblePermission(context, permissions);
      try {
        await requireHrmFeature(context.authz.user.orgId, spec.featureKey);
        return await spec.execute(context, input);
      } catch (error) {
        settleHrmRefusal(error);
      }
    },
  });
}

export const hrmShortText = (description: string, max = 500) =>
  z.string().trim().min(1).max(max).describe(description);

export const hrmOptionalText = (description: string, max = 500) =>
  z.string().trim().max(max).nullable().optional().describe(description);
