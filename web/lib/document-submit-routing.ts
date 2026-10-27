import "server-only";
import { submissionRoutesForApproval } from "@openbooks/engine/flows/module";
import { DOC_KINDS } from "./document-kinds";

/**
 * The document drawer's submit wording for an opened record: a saved draft
 * of a kind that is submitted rather than posted directly learns whether its
 * submission would park for approval, as the Flows engine plans it. Every
 * other record leaves the drawer's default wording, since it offers no
 * submit action.
 */
export async function documentSubmitRouting(
  orgId: string,
  doc: Record<string, unknown> | null | undefined,
): Promise<{ submitRoutesForApproval?: boolean }> {
  if (!doc || doc.status !== "draft") return {};
  const kind = typeof doc.kind === "string" ? doc.kind : "";
  const config = DOC_KINDS[kind];
  if (!config || config.directPost === true) return {};
  if (typeof doc.id !== "string") return {};
  return { submitRoutesForApproval: await submissionRoutesForApproval(orgId, kind, doc.id) };
}
