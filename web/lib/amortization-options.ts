import "server-only";
import { listCurrentTemplates } from "@openbooks/engine/amortization";
import { db } from "@openbooks/engine/platform/db";
import { isFeatureEnabled } from "./features";

/** Source drawers retain saved references and offer policy versions for their document date. */
export async function sourceAmortizationOptions(
  orgId: string,
  document: { doc: Record<string, unknown>; lines: readonly Record<string, unknown>[] },
): Promise<{ id: string; label: string }[] | undefined> {
  const retainedIds = document.lines.flatMap((line) =>
    typeof line.amortization_template_id === "string" ? [line.amortization_template_id] : [],
  );
  if (retainedIds.length === 0 && !(await isFeatureEnabled(orgId, "expenseAmortization")))
    return undefined;
  if (typeof document.doc.document_date !== "string")
    throw new Error("The source document date is unavailable");
  return (await listCurrentTemplates(db, orgId, document.doc.document_date, retainedIds)).map(
    (template) => ({ id: template.id, label: `${template.code} · ${template.name}` }),
  );
}
