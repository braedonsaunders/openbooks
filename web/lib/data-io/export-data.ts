import "server-only";
import type { Authz } from "../authz";
import { can } from "../authz";
import { customFieldViewerFor } from "../custom-fields";
import { getResource } from "./resources";
import { ExportRowLimitError } from "./resource-core";
import { selectExportColumns } from "./export-selection";
import { ApplicationError, forbidden, invalidInput, notFound } from "../application/errors";

/** Read an authorized resource through the shared export path without creating a binary artifact. */
export async function readDataExport(
  authz: Authz,
  resourceKey: string,
  requestedColumns?: string[],
) {
  if (!can(authz, "data.export")) throw forbidden("data.export");
  const viewer = customFieldViewerFor(authz);
  const resource = await getResource(
    authz.user.orgId,
    resourceKey,
    authz.allowedSubsidiaryIds,
    viewer,
  );
  if (!resource) throw notFound("data resource");
  if (!can(authz, resource.descriptor.readPermission))
    throw forbidden(resource.descriptor.readPermission);
  let result;
  try {
    result = await resource.read({
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      actorId: authz.user.id,
      customFieldViewer: viewer,
    });
  } catch (error) {
    if (error instanceof ExportRowLimitError) {
      throw new ApplicationError("invalid_input", error.message, 413, {
        code: error.code,
        resourceLabel: error.resourceLabel,
        limit: error.limit,
      });
    }
    throw error;
  }
  const selection = selectExportColumns(result.columns, requestedColumns);
  if (!selection.ok) throw invalidInput(selection.error);
  const selected = new Set(selection.columns.map((column) => column.key));
  const rows = result.rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => selected.has(key))),
  );
  return { descriptor: resource.descriptor, columns: selection.columns, rows };
}
