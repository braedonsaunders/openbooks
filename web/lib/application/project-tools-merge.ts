import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  findDuplicateProjects,
  mergeProjects,
  previewProjectMerge,
  projectMergeScope,
  ProjectMergeError,
} from "@openbooks/engine/projects/merge";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID from the project record or duplicate-project read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const canRead = (authz: Authz) => can(authz, "projects.read");
const canManage = (authz: Authz) => can(authz, "projects.manage");

async function requireProjects(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) throw notFound("project");
}

function settleMerge(error: unknown): never {
  if (error instanceof ProjectMergeError) {
    throw invalidInput(error.message);
  }
  throw error;
}

async function scopedPair(context: ApplicationContext, survivorId: string, duplicateId: string) {
  const rows = await projectMergeScope(context.authz.user.orgId, survivorId, duplicateId);
  if (rows.length !== 2) throw notFound("project");
  for (const row of rows) assertSubsidiaryAccess(context, row.subsidiary_id);
}

export const PROJECT_MERGE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_duplicate_projects",
    title: "List Duplicate Projects",
    description:
      "Find likely duplicate project groups by source reference, name and customer, or job number. Use the returned project ids to preview a merge.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canRead,
    featureKey: "projects",
    execute: async (context) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjects(context);
      try {
        const groups = await findDuplicateProjects(context.authz.user.orgId, {
          subsidiaryIds:
            context.authz.allowedSubsidiaryIds === null
              ? null
              : [...context.authz.allowedSubsidiaryIds],
        });
        return { ok: true, groups, href: "/projects" };
      } catch (error) {
        settleMerge(error);
      }
    },
  }),
  definition({
    name: "preview_project_merge",
    title: "Preview Project Merge",
    description:
      "Preview what will move when a duplicate project is merged into a survivor. Find both project ids with list_duplicate_projects or list_records; both must be in your subsidiary scope.",
    inputSchema: z.object({ survivorId: UUID, duplicateId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canManage,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjects(context);
      try {
        await scopedPair(context, input.survivorId, input.duplicateId);
        const preview = await previewProjectMerge(
          context.authz.user.orgId,
          input.survivorId,
          input.duplicateId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...preview, href: `/projects/${input.survivorId}` };
      } catch (error) {
        settleMerge(error);
      }
    },
  }),
  definition({
    name: "merge_duplicate_project",
    title: "Merge Duplicate Project",
    description:
      "Move the duplicate project's eligible history into its survivor in one audited transaction. Preview first with preview_project_merge; both project ids must be in your subsidiary scope.",
    inputSchema: z.object({ survivorId: UUID, duplicateId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjects(context);
      try {
        await scopedPair(context, input.survivorId, input.duplicateId);
        const result = await mergeProjects(context.authz.user.orgId, {
          survivorId: input.survivorId,
          duplicateId: input.duplicateId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: `/projects/${input.survivorId}` };
      } catch (error) {
        settleMerge(error);
      }
    },
  }),
];
