import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { readDataExport } from "../data-io/export-data";
import { assertApplicationPermission } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

export const WORKSPACE_DATA_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "export_data_rows",
    title: "Export Data Rows",
    description:
      "Read an authorized resource as structured rows for analysis or a downstream workflow, without generating a downloadable file. Requires data.export and the resource's read permission; use list_data_resources to find its key and columns.",
    inputSchema: z.object({
      resource: z.string().min(1).max(200).describe("Resource key from list_data_resources."),
      columns: z
        .array(z.string().min(1).max(200).describe("Column key from the resource descriptor."))
        .min(1)
        .max(16_384)
        .optional()
        .describe("Optional exact set of columns to return."),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum rows to return (default 100)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "data.export"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "data.export");
      const data = await readDataExport(context.authz, input.resource, input.columns);
      const maxRows = input.maxRows ?? 100;
      const rows = data.rows.slice(0, maxRows);
      return {
        resource: data.descriptor.key,
        columns: data.columns,
        rows,
        totalRows: data.rows.length,
        truncated: rows.length < data.rows.length,
        href: "/data",
      };
    },
  }),
];
