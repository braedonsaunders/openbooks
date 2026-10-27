import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import {
  listManufacturingRecords,
  manufacturingOptions,
  readManufacturingRecord,
  searchManufacturingChoices,
} from "@openbooks/engine/manufacturing/workspace";
import { getMrpRun, getPlannedOrder, listMrpRuns } from "@openbooks/engine/manufacturing/mrp";
import {
  listManufacturingInspections,
  readManufacturingInspection,
} from "@openbooks/engine/manufacturing/quality-workspace";
import {
  readSubcontractWorkspace,
  searchProductionServiceBills,
} from "@openbooks/engine/manufacturing/subcontract-workspace";
import { getManufacturingPolicies } from "@openbooks/engine/manufacturing/policies";
import { getItemPolicy } from "@openbooks/engine/manufacturing/item-policies";
import { isFeatureEnabled } from "../features";
import { forbidden } from "./errors";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { loadBomWorkspace } from "@openbooks/engine/inventory/bom-workspace";
import {
  UUID,
  assertPermission,
  assertVisibleSubsidiary,
  inOrg,
} from "./manufacturing-tools-shared";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const READ = (permission: string) => (authz: Parameters<typeof can>[0]) => can(authz, permission);
const LIST_VIEW = z.enum(["work-orders", "work-centers", "routings"]);

export const MANUFACTURING_READ_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_manufacturing_records",
    title: "List Manufacturing Records",
    description:
      "Search work orders, work centers or routings with status, text and legal-entity filters. Use the returned ids with get_manufacturing_record; the list is permission and subsidiary scoped.",
    inputSchema: z.object({
      view: LIST_VIEW.describe("Records to list: work-orders, work-centers or routings."),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("One-based result page; defaults to 1."),
      perPage: z
        .number()
        .int()
        .min(10)
        .max(100)
        .optional()
        .describe("Rows per page; defaults to 25."),
      query: z.string().max(200).optional().describe("Search number, item, code or name."),
      status: z.string().max(30).optional().describe("Exact status filter returned by the list."),
      subsidiaryId: UUID("Legal-entity id from manufacturing options").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context, input) =>
      withScopeSnapshot(context.authz.user.orgId, async () => ({
        ok: true,
        ...(await listManufacturingRecords(
          db,
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
          input.view,
          {
            page: input.page,
            perPage: input.perPage,
            q: input.query,
            status: input.status,
            subsidiaryId: input.subsidiaryId,
          },
          context.authz.user.id,
        )),
        href: `/manufacturing/${input.view}`,
      })),
  }),
  definition({
    name: "get_manufacturing_record",
    title: "Get Manufacturing Record",
    description:
      "Read one work order, work center or routing with its related operations, materials and history. Copy the id from list_manufacturing_records; the underlying record read applies subsidiary and resource visibility.",
    inputSchema: z.object({
      view: LIST_VIEW.describe("Record kind: work-orders, work-centers or routings."),
      id: UUID(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context, input) =>
      withScopeSnapshot(context.authz.user.orgId, async () => ({
        ok: true,
        ...(await readManufacturingRecord(
          db,
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
          input.view,
          input.id,
          context.authz.user.id,
        )),
        href: `/manufacturing/${input.view}?record=${encodeURIComponent(input.id)}`,
      })),
  }),
  definition({
    name: "get_manufacturing_options",
    title: "Get Manufacturing Options",
    description:
      "Find eligible items, locations, vendors or work centers for manufacturing commands, including selected records. Use this before creating work orders, routings or subcontracts when an id is missing.",
    inputSchema: z.object({
      kind: z
        .enum(["all", "items", "locations", "vendors", "centers"])
        .describe("Option list to read."),
      query: z.string().max(200).optional().describe("Optional text search."),
      selectedId: UUID("Previously selected item, location, vendor or center id").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      if (input.kind === "vendors") assertPermission(context, "ap.create");
      return withScopeSnapshot(context.authz.user.orgId, async () => ({
        ok: true,
        data:
          input.kind === "all"
            ? await manufacturingOptions(
                db,
                context.authz.user.orgId,
                context.authz.allowedSubsidiaryIds,
                can(context.authz, "ap.create"),
                context.authz.user.id,
              )
            : await searchManufacturingChoices(
                db,
                context.authz.user.orgId,
                context.authz.allowedSubsidiaryIds,
                input.kind,
                input.query,
                input.selectedId,
                context.authz.user.id,
              ),
        href: "/manufacturing",
      }));
    },
  }),
  definition({
    name: "get_manufacturing_policies",
    title: "Get Manufacturing Policies",
    description:
      "Read organization-wide manufacturing shortage, completion-tolerance and abnormal-scrap approval settings. Use before changing policy values; only an unrestricted manufacturing reader can access this configuration.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context) => {
      assertPermission(context, "manufacturing.read");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      return inOrg(context, async () => ({
        ok: true,
        ...(await getManufacturingPolicies(db, context.authz.user.orgId)),
        href: "/admin/setup/manufacturing",
      }));
    },
  }),
  definition({
    name: "get_manufacturing_item_policy",
    title: "Get Manufacturing Item Policy",
    description:
      "Read an item's make, buy or transfer planning policy and exact quantity buffers. Copy itemId from item or manufacturing reads before changing its policy.",
    inputSchema: z.object({ itemId: UUID("Item id from item or manufacturing reads") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return inOrg(context, async () => ({
        ok: true,
        ...(await getItemPolicy(db, context.authz.user.orgId, input.itemId)),
        href: `/inventory/items?record=${encodeURIComponent(input.itemId)}`,
      }));
    },
  }),
  definition({
    name: "list_manufacturing_inspections",
    title: "List Manufacturing Inspections",
    description:
      "Search the manufacturing inspection queue by work order, legal entity, status or text. Use an inspection id from the results with get_manufacturing_inspection.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records").optional(),
      subsidiaryId: UUID("Legal-entity id from manufacturing options").optional(),
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Search item, inspection plan, lot or serial."),
      status: z.enum(["pending", "pass", "fail"]).optional().describe("Inspection status filter."),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("One-based result page; defaults to 1."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "manufacturing.read") && can(authz, "items.read"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      assertPermission(context, "items.read");
      return inOrg(context, async () => ({
        ok: true,
        ...(await listManufacturingInspections(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          {
            workOrderId: input.workOrderId,
            subsidiaryId: input.subsidiaryId,
            q: input.query,
            status: input.status,
            page: input.page,
          },
        )),
        href: "/manufacturing/quality",
      }));
    },
  }),
  definition({
    name: "get_manufacturing_inspection",
    title: "Get Manufacturing Inspection",
    description:
      "Read an inspection's measurements, disposition choices and linked work-order or inventory evidence. Copy the id from list_manufacturing_inspections.",
    inputSchema: z.object({ id: UUID("Inspection id from list_manufacturing_inspections") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return inOrg(context, async () => ({
        ok: true,
        ...(await readManufacturingInspection(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
        )),
        href: `/manufacturing/quality?inspection=${encodeURIComponent(input.id)}`,
      }));
    },
  }),
  definition({
    name: "list_mrp_runs",
    title: "List MRP Runs",
    description:
      "List saved MRP runs for a legal entity. Use run ids from this result with get_mrp_run; use returned planned-order ids to firm, dismiss or convert suggestions.",
    inputSchema: z.object({
      subsidiaryId: UUID("Legal-entity id from manufacturing options"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum runs to return; defaults to 20."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      assertVisibleSubsidiary(context, input.subsidiaryId);
      return inOrg(context, async () => ({
        ok: true,
        runs: await listMrpRuns(db, context.authz.user.orgId, input.subsidiaryId, input.limit),
        href: "/manufacturing/mrp",
      }));
    },
  }),
  definition({
    name: "get_mrp_run",
    title: "Get MRP Run",
    description:
      "Read one saved material-requirements run and its planned orders. Copy the run id from list_mrp_runs; returned suggestion ids can be confirmed, dismissed or converted.",
    inputSchema: z.object({ id: UUID("MRP run id from list_mrp_runs") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return inOrg(context, async () => {
        const result = await getMrpRun(
          db,
          context.authz.user.orgId,
          input.id,
          context.authz.allowedSubsidiaryIds,
        );
        assertVisibleSubsidiary(context, String(result.run.parameters.subsidiaryId ?? ""));
        return {
          ok: true,
          ...result,
          href: `/manufacturing/mrp?record=${encodeURIComponent(input.id)}`,
        };
      });
    },
  }),
  definition({
    name: "get_mrp_planned_order",
    title: "Get MRP Planned Order",
    description:
      "Read one planned order's suggested supply action, quantity, date and conversion status. Copy the id from get_mrp_run before firming, dismissing or converting it.",
    inputSchema: z.object({ id: UUID("Planned-order id from get_mrp_run") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return inOrg(context, async () => {
        const plannedOrder = await getPlannedOrder(db, context.authz.user.orgId, input.id);
        assertVisibleSubsidiary(context, plannedOrder.subsidiaryId);
        return {
          ok: true,
          ...plannedOrder,
          href: `/manufacturing/mrp?record=${encodeURIComponent(plannedOrder.run_id)}`,
        };
      });
    },
  }),
  definition({
    name: "get_production_subcontract",
    title: "Get Production Subcontract",
    description:
      "Read subcontract shipments, returns, service bills and open balances for a work order. Copy the work-order id from manufacturing records and the subcontract id from this result.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      selectedSubcontractId: UUID("Subcontract id from an earlier subcontract read").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("manufacturing.read"),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return inOrg(context, async () => ({
        ok: true,
        ...(await readSubcontractWorkspace(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.workOrderId,
          input.selectedSubcontractId,
        )),
        href: `/manufacturing/work-orders?record=${encodeURIComponent(input.workOrderId)}`,
      }));
    },
  }),
  definition({
    name: "search_production_service_bills",
    title: "Search Production Service Bills",
    description:
      "Find bills eligible to capitalize subcontract service for a work order and subcontract. Copy both ids from get_production_subcontract before linking a bill.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      query: z.string().max(200).optional().describe("Search bill number or vendor."),
      selectedBillId: UUID("Bill id from an earlier bill search").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ("ap.read"),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "ap.read");
      return inOrg(context, async () => ({
        ok: true,
        ...(await searchProductionServiceBills(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.workOrderId,
          input.subcontractId,
          input.query ?? "",
          input.selectedBillId,
        )),
        href: `/manufacturing/work-orders?record=${encodeURIComponent(input.workOrderId)}`,
      }));
    },
  }),
  definition({
    name: "inspect_manufacturing_bom",
    title: "Inspect Manufacturing BOM",
    description:
      "Read an assembly's current bill of materials, effective component lines and eligible references before proposing a revision. Use an item id from item reads; the recipe version is returned as expectedVersion.",
    inputSchema: z.object({
      assemblyItemId: UUID("Assembly item id from item reads"),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "items.read") || can(authz, "admin.setup.manage"),
    featureKey: "inventory",
    execute: async (context, input) => {
      if (!can(context.authz, "items.read") && !can(context.authz, "admin.setup.manage"))
        throw forbidden("items.read");
      return {
        ok: true,
        ...(await loadBomWorkspace({
          orgId: context.authz.user.orgId,
          assemblyItemId: input.assemblyItemId,
          manufacturingEnabled: await isFeatureEnabled(context.authz.user.orgId, "manufacturing"),
          canProposeRevision:
            context.authz.allowedSubsidiaryIds === null &&
            can(context.authz, "manufacturing.manage") &&
            can(context.authz, "admin.setup.manage"),
          today: await businessToday(context.authz.user.orgId),
        })),
        href: `/inventory/bom?assemblyItemId=${encodeURIComponent(input.assemblyItemId)}`,
      };
    },
  }),
];
