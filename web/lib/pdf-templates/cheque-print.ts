import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { db } from "@openbooks/engine/platform/db";
import { lockIssuedChequePrint } from "@openbooks/engine/payroll/cheques";
import { PayrollError } from "@openbooks/engine/payroll/error";
import type { ResolvedPdfTemplate } from "./store";
import { mergeAndPrintPdf } from "./render";

export async function printIssuedCheque(
  orgId: string,
  stubId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  template: ResolvedPdfTemplate,
  values: Record<string, unknown>,
) {
  const input = { orgId, stubId, actorId, allowedSubsidiaryIds: scope };
  const issued = await db.transaction((tx) => lockIssuedChequePrint(tx, input));
  if (values.cheque_number !== issued.chequeNumber)
    throw new PayrollError("Reload this issued cheque before printing");
  const pdf = await mergeAndPrintPdf(template, values);
  if ((await PDFDocument.load(pdf)).getPageCount() !== 1)
    throw new PayrollError(
      "Each cheque must fit exactly one stock sheet; adjust its layout and preview again",
    );
  await db.transaction(async (tx) => {
    const live = await lockIssuedChequePrint(tx, input);
    if (live.chequeNumber !== issued.chequeNumber)
      throw new PayrollError("Cheque identity changed during printing; reload before printing");
    const audit = await tx.execute<{ id: string }>(
      sql`
      insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'pay_stubs',${stubId},'update',${JSON.stringify({ event: "cheque_printed", chequeNumber: issued.chequeNumber, template: template.provenance, contentHash: createHash("sha256").update(pdf).digest("hex") })}::jsonb,${actorId}) returning id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new PayrollError("Cheque print audit was not recorded");
  });
  return pdf;
}
