import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

type CoreZodType = z.core.$ZodType;

export const TALENT_UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a native read tool; never invent one.");
export const TALENT_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const TALENT_IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

const MAX_TOOL_STRING_LENGTH = 100_000;
const MAX_TOOL_ARRAY_ITEMS = 1_000;

function payloadSchema(bodySchema: CoreZodType | undefined, description: string): z.ZodType {
  if (!bodySchema) return z.object({}).describe(description);
  if (bodySchema instanceof z.ZodObject) {
    const describedShape = Object.fromEntries(
      Object.entries(bodySchema.shape).map(([key, field]) => [
        key,
        inputSchemaFor(field, key).describe(
          field.description ?? `Native ${key} value accepted by this command.`,
        ),
      ]),
    );
    return z.object(describedShape).passthrough().describe(description);
  }
  return inputSchemaFor(bodySchema).describe(description);
}

function inputSchemaFor(schema: CoreZodType, propertyName?: string): z.ZodType {
  if (propertyName && /^(?:id|.+Id)$/.test(propertyName)) return uuidInputFor(schema);
  if (schema instanceof z.ZodPipe) return inputSchemaFor(schema.in, propertyName);
  if (schema instanceof z.ZodOptional)
    return z.optional(inputSchemaFor(schema.unwrap(), propertyName));
  if (schema instanceof z.ZodNullable)
    return z.nullable(inputSchemaFor(schema.unwrap(), propertyName));
  if (schema instanceof z.ZodUnion) {
    return z.union(
      schema.options.map((option) => inputSchemaFor(option)) as [z.ZodType, ...z.ZodType[]],
    );
  }
  if (schema instanceof z.ZodIntersection)
    return z.intersection(
      inputSchemaFor(schema._zod.def.left),
      inputSchemaFor(schema._zod.def.right),
    );
  if (schema instanceof z.ZodArray) {
    const bounds = arrayBounds(schema);
    return z.array(inputSchemaFor(schema.element)).min(bounds.minimum).max(bounds.maximum);
  }
  if (schema instanceof z.ZodObject) {
    return z.object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [
          key,
          inputSchemaFor(field, key).describe(
            field.description ?? `Native ${key} value accepted by this command.`,
          ),
        ]),
      ),
    );
  }
  const schemaDefinition = schema._zod.def;
  const directDateTimePattern =
    "format" in schemaDefinition &&
    schemaDefinition.format === "datetime" &&
    "pattern" in schemaDefinition
      ? schemaDefinition.pattern
      : undefined;
  const dateTimeCheck = schemaDefinition.checks?.find((check) => {
    const checkDefinition = check._zod.def;
    return (
      checkDefinition.check === "string_format" &&
      "format" in checkDefinition &&
      checkDefinition.format === "datetime"
    );
  });
  const dateTimeCheckDefinition = dateTimeCheck?._zod.def;
  const dateTimeCheckPattern =
    dateTimeCheckDefinition && "pattern" in dateTimeCheckDefinition
      ? dateTimeCheckDefinition.pattern
      : undefined;
  const dateTimePattern =
    directDateTimePattern instanceof RegExp
      ? directDateTimePattern
      : dateTimeCheckPattern instanceof RegExp
        ? dateTimeCheckPattern
        : undefined;
  if (dateTimePattern instanceof RegExp) {
    return z.string().regex(dateTimePattern).max(MAX_TOOL_STRING_LENGTH);
  }
  if (schema instanceof z.ZodString) return schema.max(MAX_TOOL_STRING_LENGTH);
  return schema;
}

function arrayBounds(schema: z.ZodArray): { minimum: number; maximum: number } {
  const checks = schema._zod.def.checks ?? [];
  let minimum = 0;
  let maximum = MAX_TOOL_ARRAY_ITEMS;
  for (const check of checks) {
    const definition = check._zod.def;
    if (
      definition.check === "min_length" &&
      "minimum" in definition &&
      typeof definition.minimum === "number"
    ) {
      minimum = Math.max(minimum, definition.minimum);
    }
    if (
      definition.check === "max_length" &&
      "maximum" in definition &&
      typeof definition.maximum === "number"
    ) {
      maximum = Math.min(maximum, definition.maximum);
    }
    if (
      definition.check === "length_equals" &&
      "length" in definition &&
      typeof definition.length === "number"
    ) {
      minimum = Math.max(minimum, definition.length);
      maximum = Math.min(maximum, definition.length);
    }
    if (
      definition.check === "size_equals" &&
      "size" in definition &&
      typeof definition.size === "number"
    ) {
      minimum = Math.max(minimum, definition.size);
      maximum = Math.min(maximum, definition.size);
    }
  }
  return { minimum, maximum };
}

function uuidInputFor(schema: CoreZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) return z.optional(uuidInputFor(schema.unwrap()));
  if (schema instanceof z.ZodNullable) return z.nullable(uuidInputFor(schema.unwrap()));
  return TALENT_UUID;
}
export type TalentCommandInput = {
  idempotencyKey: string;
  payload: Record<string, unknown>;
  recordId?: string;
  relatedId?: string;
  recordName?: string;
  relatedName?: string;
};

export function talentCommand(args: {
  name: string;
  title: string;
  description: string;
  permission: string | null;
  featureKey?: string;
  requiredFeatureKeys?: string[];
  permissionAnyOf?: string[];
  idempotencyKeySchema?: CoreZodType;
  unrestrictedScope?: boolean;
  beforeInvoke?: (context: ApplicationContext) => Promise<void>;
  recordId?: { name: string; description: string };
  relatedId?: { name: string; description: string };
  payloadDescription?: string;
  bodySchema?: CoreZodType;
  validationStatus?: number;
  destructive?: boolean;
  openWorld?: boolean;
  href: string | ((result: Record<string, unknown>, input: TalentCommandInput) => string);
  invoke: (
    context: ApplicationContext,
    input: TalentCommandInput,
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  const shape: Record<string, z.ZodType> = {
    ...(args.recordId
      ? {
          [args.recordId.name]: TALENT_UUID.describe(args.recordId.description),
        }
      : {}),
    ...(args.relatedId
      ? {
          [args.relatedId.name]: TALENT_UUID.describe(args.relatedId.description),
        }
      : {}),
    payload: payloadSchema(
      args.bodySchema,
      args.payloadDescription ?? "Fields accepted by the native command.",
    ),
    idempotencyKey: args.idempotencyKeySchema ?? TALENT_IDEMPOTENCY_KEY,
  };
  const inputSchema = z.object(shape);

  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "always",
    featureKey: args.featureKey,
    visibleTo: (authz) =>
      args.permission
        ? can(authz, args.permission)
        : args.permissionAnyOf
          ? args.permissionAnyOf.some((permission) => can(authz, permission))
          : true,
    execute: async (context, input) => {
      const rawInput = input as Record<string, unknown>;
      const commandInput = {
        ...rawInput,
        ...(args.recordId ? { recordId: rawInput[args.recordId.name] } : {}),
        ...(args.relatedId ? { relatedId: rawInput[args.relatedId.name] } : {}),
        ...(args.recordId ? { recordName: args.recordId.name } : {}),
        ...(args.relatedId ? { relatedName: args.relatedId.name } : {}),
      } as TalentCommandInput;
      if (args.permission) assertApplicationPermission(context, args.permission);
      else if (args.permissionAnyOf?.length) {
        const granted = args.permissionAnyOf.find((permission) => can(context.authz, permission));
        if (!granted) throw forbidden(args.permissionAnyOf.join(" or "));
        assertApplicationPermission(context, granted);
      }
      if (args.unrestrictedScope && context.authz.allowedSubsidiaryIds !== null) {
        throw forbidden("subsidiary.unrestricted");
      }
      for (const featureKey of new Set([args.featureKey, ...(args.requiredFeatureKeys ?? [])])) {
        if (featureKey && !(await isFeatureEnabled(context.authz.user.orgId, featureKey))) {
          throw notFound(featureKey);
        }
      }
      let payload: Record<string, unknown>;
      try {
        payload = args.bodySchema
          ? (args.bodySchema.parse(commandInput.payload) as Record<string, unknown>)
          : commandInput.payload;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ApplicationError(
            "invalid_input",
            "The native command rejected one or more input fields.",
            args.validationStatus ?? 400,
            {
              issues: error.issues.slice(0, 20),
            },
          );
        }
        throw error;
      }
      try {
        if (args.beforeInvoke) await args.beforeInvoke(context);
        const result = await args.invoke(context, commandInput, payload);
        return {
          ok: true,
          ...result,
          href: typeof args.href === "string" ? args.href : args.href(result, commandInput),
        };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  });
}

/** Preserve domain refusals and their operator-facing remedy across adapters. */
export function settleTalentRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error && error.name === "DuplicateProspectError") {
    const duplicate = error as Error & { candidateId?: unknown; survivorName?: unknown };
    throw conflict(error.message, {
      domainCode: "duplicate-email",
      ...(typeof duplicate.candidateId === "string"
        ? {
            candidate: {
              id: duplicate.candidateId,
              ...(typeof duplicate.survivorName === "string"
                ? { displayName: duplicate.survivorName }
                : {}),
            },
          }
        : {}),
    });
  }
  if (error && typeof error === "object") {
    const refusal = error as {
      message?: unknown;
      status?: unknown;
      remedy?: unknown;
      field?: unknown;
      code?: unknown;
    };
    const status =
      typeof refusal.status === "number"
        ? refusal.status
        : refusal.code === "NOT_FOUND" || refusal.code === "FEATURE_OFF"
          ? 404
          : refusal.code === "BAD_STATE" ||
              refusal.code === "STALE_REVISION" ||
              refusal.code === "DUPLICATE"
            ? 409
            : refusal.code === "FORBIDDEN"
              ? 403
              : refusal.code === "VALIDATION" || refusal.code === "INVALID_INPUT"
                ? 400
                : refusal.code === "REFUSED"
                  ? 422
                  : undefined;
    if (
      typeof refusal.message === "string" &&
      typeof status === "number" &&
      status >= 400 &&
      status < 500
    ) {
      const details: Record<string, unknown> = {};
      if (typeof refusal.remedy === "string") details.remedy = refusal.remedy;
      if (typeof refusal.field === "string") details.field = refusal.field;
      if (typeof refusal.code === "string") details.domainCode = refusal.code;
      if (status === 403) throw new ApplicationError("forbidden", refusal.message, status, details);
      if (status === 404) throw new ApplicationError("not_found", refusal.message, status, details);
      if (status === 409) throw conflict(refusal.message, details);
      if (status === 422)
        throw new ApplicationError("unsupported_operation", refusal.message, status, details);
      throw new ApplicationError("invalid_input", refusal.message, status, details);
    }
  }
  if (error instanceof Error) {
    if (error.name === "HrmAuthorizationError") {
      if (/not visible in this organization/i.test(error.message)) {
        throw notFound("HRM subject");
      }
      throw forbidden(error.message);
    }
    if (error.name === "UnrestrictedScopeError") throw forbidden(error.message);
    if (error.name === "HrmQualificationError") {
      const status = /must be|unknown|needs|blank|at least|requires evidence/i.test(error.message)
        ? 400
        : /does not exist|no longer|not exist here|not found|cannot be read back|no row was written/i.test(
              error.message,
            )
          ? 404
          : 422;
      throw new ApplicationError(
        status === 404 ? "not_found" : "invalid_input",
        error.message,
        status,
      );
    }
  }
  throw error;
}
