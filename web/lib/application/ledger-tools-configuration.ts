import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  listOperatingProfileChoices,
  publishOperatingProfile,
  saveOperatingProfileScope,
} from "@openbooks/engine/organization/operating-profiles";
import { readOperatingSetupJourney } from "@openbooks/engine/manufacturing/setup-journey";
import { proposeProvisionAssessment } from "@openbooks/engine/provisions";
import { bookReplicationStatus, listBookReplicationRuns } from "@openbooks/engine/multibook";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db, withOrg, withOrgTransaction } from "@openbooks/engine/platform/db";
import { readEntityListPage } from "../list/entity-reader";
import { provisionAssessmentToolSchema } from "../provisions/assessment-schema";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a native setup read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact setup mutation.");

function recordIdFromKey(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const hasPermission = (permission: string) => (authz: ApplicationContext["authz"]) =>
  can(authz, permission);

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error) {
    const typed = error as Error & {
      status?: unknown;
      code?: unknown;
      remedy?: unknown;
      details?: unknown;
    };
    if (typeof typed.status === "number") {
      const details = {
        ...(typed.details && typeof typed.details === "object" && !Array.isArray(typed.details)
          ? (typed.details as Record<string, unknown>)
          : {}),
        ...(typeof typed.code === "string" ? { code: typed.code } : {}),
        ...(typeof typed.remedy === "string" ? { remedy: typed.remedy } : {}),
      };
      if (typed.status === 403)
        throw new ApplicationError("forbidden", typed.message, 403, details);
      if (typed.status === 404)
        throw new ApplicationError("not_found", typed.message, 404, details);
      if (typed.status === 409) throw new ApplicationError("conflict", typed.message, 409, details);
      throw invalidInput(typed.message, details);
    }
  }
  throw error;
}

export const LEDGER_CONFIGURATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_accounting_book_replication_status",
    title: "Get Accounting Book Replication Status",
    description:
      "Read each active secondary book's replication completeness and change history. Use list_setup_records for the accounting-books entity to find book ids; use the accounting-book-replication setup entity to inspect individual change records.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("gl.read"),
    featureKey: "multiBookAccounting",
    execute: async (context) => {
      assertApplicationPermission(context, "gl.read");
      const orgId = context.authz.user.orgId;
      return withOrg(orgId, async () => ({
        ok: true,
        replication: await bookReplicationStatus(orgId, await businessToday(orgId)),
        replicationRuns: await listBookReplicationRuns(orgId),
      }));
    },
  }),
  definition({
    name: "list_accounting_changes",
    title: "List Accounting Changes",
    description:
      "List the accounting change queue with current status, domain, effective date, subject, and reason. Use this to find proposal ids before submitting or reviewing a change.",
    inputSchema: z.object({
      page: z.number().int().min(1).max(10_000).optional().describe("Page number, starting at 1."),
      perPage: z.number().int().min(5).max(100).optional().describe("Rows per page, default 25."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("gl.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.read");
      return readEntityListPage({
        recordType: "financial_change",
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds:
          context.authz.allowedSubsidiaryIds === null
            ? null
            : new Set(context.authz.allowedSubsidiaryIds),
        page: input.page,
        perPage: input.perPage,
      });
    },
  }),
  definition({
    name: "propose_provision_assessment",
    title: "Propose Provision Assessment",
    description:
      "Create an evidenced assessment proposal for an existing provision obligation; it remains subject to the accounting approval flow. Use list_records for provision_obligation to find obligation ids and list_accounting_changes to verify the proposal or find it for submission.",
    inputSchema: provisionAssessmentToolSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("gl.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.manage");
      try {
        const id = await proposeProvisionAssessment(
          context.authz.user.orgId,
          context.authz.user.id,
          input,
        );
        return {
          ok: true,
          id,
          status: "proposed",
          href: `/accounting/changes?change=${id}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "publish_operating_profile",
    title: "Publish Operating Profile",
    description:
      "Create or publish a versioned project or production workflow definition. Use list_operating_profile_choices and get_operating_setup_journey to review available profiles and required features; updates require the current version and an audit reason.",
    inputSchema: z
      .object({
        profileId: UUID.optional().describe(
          "Existing operating profile id for a version update; omit to create.",
        ),
        code: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,79}$/)
          .describe("Stable lowercase profile code."),
        name: z.string().trim().min(1).max(120).describe("Display name for the workflow."),
        definition: z
          .record(z.string(), z.json())
          .describe("Validated workflow definition object."),
        reason: z
          .string()
          .trim()
          .min(5)
          .max(500)
          .describe("Reason recorded with this profile version."),
        isActive: z.boolean().optional().describe("Whether the profile is available for new work."),
        expectedVersion: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Current version, required when updating an existing profile."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if (input.profileId && input.expectedVersion === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["expectedVersion"],
            message: "required for profile updates",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, () =>
          publishOperatingProfile(db, context.authz.user.orgId, context.authz.user.id, {
            id: input.profileId ?? recordIdFromKey(input.idempotencyKey),
            code: input.code,
            name: input.name,
            definition: input.definition,
            reason: input.reason,
            expectedVersion: input.expectedVersion ?? 0,
            isActive: input.isActive,
          }),
        );
        return {
          ok: true,
          ...result,
          status: "published",
          href: "/admin/setup/operating-profiles",
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "save_operating_profile_scope",
    title: "Save Operating Profile Scope",
    description:
      "Set the allowed workflows and default for one organization or department and work family. Use list_operating_profile_choices to find active profile ids; updates require the current scope revision and a reason.",
    inputSchema: z
      .object({
        scopeId: UUID.optional().describe("Existing scope id for an update; omit to create."),
        departmentId: UUID.nullable().describe(
          "Department id for this scope, or null for organization-wide defaults.",
        ),
        family: z.enum(["project", "production"]).describe("Work family covered by the scope."),
        profileIds: z
          .array(UUID)
          .min(1)
          .max(100)
          .describe("Distinct active profile ids allowed in this scope."),
        defaultProfileId: UUID.nullable().describe(
          "Default from profileIds, or null when users must choose.",
        ),
        reason: z
          .string()
          .trim()
          .min(5)
          .max(500)
          .describe("Reason recorded with the scope change."),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Current scope revision, required for updates."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if (input.scopeId && input.expectedRevision === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["expectedRevision"],
            message: "required for scope updates",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, () =>
          saveOperatingProfileScope(db, context.authz.user.orgId, context.authz.user.id, {
            id: input.scopeId ?? recordIdFromKey(input.idempotencyKey),
            departmentId: input.departmentId,
            family: input.family,
            profileIds: input.profileIds,
            defaultProfileId: input.defaultProfileId,
            reason: input.reason,
            expectedRevision: input.expectedRevision ?? 0,
          }),
        );
        return { ok: true, ...result, status: "saved", href: "/admin/setup/operating-profiles" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "list_operating_profile_choices",
    title: "List Operating Profile Choices",
    description:
      "List the active workflows available for a project or production family. Use a returned choice value with get_operating_setup_journey; Setup reads provide department ids.",
    inputSchema: z.object({
      family: z.enum(["project", "production"]).describe("Work family to list choices for."),
      departmentId: UUID.optional().describe("Optional department used to resolve scoped choices."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "projects.read") || can(authz, "manufacturing.read"),
    execute: async (context, input) => {
      const permission = input.family === "project" ? "projects.read" : "manufacturing.read";
      assertApplicationPermission(context, permission);
      try {
        const choices = await withOrgTransaction(context.authz.user.orgId, () =>
          listOperatingProfileChoices(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.family,
            input.departmentId ?? null,
          ),
        );
        return { ok: true, choices, href: "/admin/setup/operating-profiles" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "get_operating_setup_journey",
    title: "Get Operating Setup Journey",
    description:
      "Check whether a selected operating profile is ready for project or production work and return its supported next step. Use list_operating_profile_choices to find a selection and Setup reads to resolve related ids.",
    inputSchema: z.object({
      family: z.enum(["project", "production"]).describe("Operating profile family."),
      selection: z
        .string()
        .min(1)
        .max(100)
        .describe("Choice value returned by list_operating_profile_choices."),
      departmentId: UUID.optional().describe("Optional department used to resolve the choice."),
      itemId: UUID.optional().describe("Inventory item for production readiness."),
      subsidiaryId: UUID.optional().describe("Legal entity for production readiness."),
      quantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .optional()
        .describe("Exact production quantity as a decimal string."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, () =>
          readOperatingSetupJourney(db, context.authz.user.orgId, context.authz.user.id, input),
        );
        return { ok: true, ...result, href: result.nextHref };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
