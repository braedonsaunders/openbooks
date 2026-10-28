import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { canRunReportEntity } from "../report-authz";
import { createView, deleteView, loadView, loadViews, runView, updateView } from "../views";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by the saved view list.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function viewIdempotencyId(orgId: string, key: string): string {
  const hash = createHash("sha256").update(`saved-view:${orgId}:${key}`).digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isAdmin(context: ApplicationContext) {
  return context.authz.permissions.has("*");
}

async function visibleView(context: ApplicationContext, id: string) {
  const { user, permissions } = context.authz;
  const view = await loadView(user.orgId, id, user.id, permissions);
  if (!view || !(await canRunReportEntity(context.authz, view.query))) throw notFound("view");
  return view;
}

export const WORKSPACE_VIEW_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_saved_views",
    title: "List Saved Views",
    description:
      "List saved views visible to you whose report data you can access. Use the returned view id with get_saved_view, run_saved_view, or an edit command.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "reports.read");
      const views = await loadViews(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.permissions,
      );
      const visible = [];
      for (const view of views)
        if (await canRunReportEntity(context.authz, view.query)) visible.push(view);
      return { views: visible, href: "/knowledge/views" };
    },
  }),
  definition({
    name: "get_saved_view",
    title: "Get Saved View",
    description:
      "Read a saved view you can see and execute. Use list_saved_views to resolve its id before editing or running it.",
    inputSchema: z.object({ viewId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.read");
      const view = await visibleView(context, input.viewId);
      return { view, href: `/knowledge/views/${view.id}` };
    },
  }),
  definition({
    name: "create_saved_view",
    title: "Create Saved View",
    description:
      "Create a private saved view with the default ledger query, then use update_saved_view to set its query and sharing options. Requires reports.create; use list_saved_views to verify the new view.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Saved view name."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.create");
      const created = await createView({
        orgId: context.authz.user.orgId,
        userId: context.authz.user.id,
        idempotencyKey: viewIdempotencyId(context.authz.user.orgId, input.idempotencyKey),
        name: input.name,
      });
      return {
        ok: true,
        viewId: created.id,
        slug: created.slug,
        status: "created",
        href: `/knowledge/views/${created.id}`,
      };
    },
  }),
  definition({
    name: "update_saved_view",
    title: "Update Saved View",
    description:
      "Update a visible saved view's name, description, query, layout, sharing scope, or allowed roles. Requires reports.create and ownership or admin authority; use get_saved_view for the current query before editing.",
    inputSchema: z
      .object({
        viewId: UUID,
        name: z.string().trim().min(1).max(200).optional().describe("New view name."),
        description: z
          .string()
          .max(2000)
          .nullable()
          .optional()
          .describe("Description, or null to clear it."),
        query: z.json().optional().describe("Replacement saved report query."),
        layout: z.json().nullable().optional().describe("View column and display layout."),
        scope: z
          .enum(["private", "shared"])
          .optional()
          .describe("Private owner-only or shared organization visibility."),
        allowedRoles: z
          .array(z.string().min(1).max(100))
          .max(100)
          .nullable()
          .optional()
          .describe("Optional role allowlist for a shared view."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        ({ name, description, query, layout, scope, allowedRoles }) =>
          name !== undefined ||
          description !== undefined ||
          query !== undefined ||
          layout !== undefined ||
          scope !== undefined ||
          allowedRoles !== undefined,
        "provide a view field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.create");
      const current = await visibleView(context, input.viewId);
      if (input.query !== undefined && !(await canRunReportEntity(context.authz, input.query)))
        throw forbidden("report.entity.read");
      const updated = await updateView(
        context.authz.user.orgId,
        input.viewId,
        context.authz.user.id,
        isAdmin(context),
        {
          name: input.name,
          description: input.description,
          query: input.query,
          layout: input.layout,
          scope: input.scope,
          allowedRoles: input.allowedRoles,
        },
      );
      if (!updated.ok) throw invalidInput(updated.error);
      const view = await visibleView(context, input.viewId);
      return {
        ok: true,
        viewId: input.viewId,
        view,
        status: "updated",
        href: `/knowledge/views/${current.id}`,
      };
    },
  }),
  definition({
    name: "delete_saved_view",
    title: "Delete Saved View",
    description:
      "Delete a saved view you own or administer. Requires reports.create; use list_saved_views to resolve the id and confirm the view is removed.",
    inputSchema: z.object({ viewId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.create");
      await visibleView(context, input.viewId);
      if (
        !(await deleteView(
          context.authz.user.orgId,
          input.viewId,
          context.authz.user.id,
          isAdmin(context),
        ))
      )
        throw forbidden("reports.create");
      return { ok: true, viewId: input.viewId, status: "deleted", href: "/knowledge/views" };
    },
  }),
  definition({
    name: "run_saved_view",
    title: "Run Saved View",
    description:
      "Run the current data query for a saved view you can access. Requires reports.read and the entity permission and feature switches required by that query; use list_saved_views to resolve its id.",
    inputSchema: z.object({
      viewId: UUID,
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("Maximum result rows (default 10,000)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.read");
      const view = await visibleView(context, input.viewId);
      const result = await runView(context.authz.user.orgId, view.query, input.maxRows);
      return { result, href: `/knowledge/views/${view.id}` };
    },
  }),
];
