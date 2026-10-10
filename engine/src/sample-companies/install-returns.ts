import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createDocument } from "../ledger/document-write.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { runRecordFlows } from "../flows/index.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { authorizeReturn, receiveReturn, rejectReturn } from "../sales/returns.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/** Three independently shipped goods returns retain requested, received and rejected evidence. */
export async function installOperatingReturns(c: DemoContext): Promise<void> {
  if (!sampleCompanyFeatures(c.industryKey).returnAuthorizations) return;
  const id = (table: string, key: string) => scenarioRecordId(c, table, key);
  const scope = new Set([c.subsidiaryId]);
  for (let n = 1; n <= 3; n++) {
    const invoiceId = id("documents", `operations-return-sale-${n}`);
    const returnId = id("documents", `operations-return-${n}`);
    if ((await db.execute(sql`select id from documents where org_id=${c.orgId} and id=${returnId}`)).rows.length) continue;
    const itemId = id("items", `operating-stock-${n}`);
    const stockLocationId = id("stock_locations", "main");
    const partyId = id("parties", `operations-customer-${n}`);
    for (const kind of ["customer_invoice", "rma"] as const) {
      const key = kind === "rma" ? returnId : invoiceId;
      if ((await db.execute(sql`select id from documents where org_id=${c.orgId} and id=${key}`)).rows.length) {
        throw new SampleCompanyError(`Existing return source ${key} has no matching authored return. Its records are preserved; review the native shipment and use a new scenario identity before refreshing.`);
      }
      const body = { partyId, documentDate: c.operationDate ?? c.date, externalSource: "industry_demo",
        externalRef: `operations-return-${kind === "rma" ? "request" : "sale"}-${n}`,
        memo: kind === "rma" ? "Synthetic goods return for specification review" : "Synthetic trade delivery supporting a traceable goods return",
        lines: [{ itemId, stockLocationId, accountId: c.accounts.revenue, quantity: kind === "rma" ? "1.00" : "5.00", unitPrice: "35.00", amount: kind === "rma" ? "35.00" : "175.00" }] };
      const created = await createDocument({ orgId: c.orgId, userId: c.actorId, kind, key, body, requestBody: body, subsidiaryId: c.subsidiaryId });
      if (created.status !== "created") throw new SampleCompanyError("Return scenario identity was claimed concurrently; retry after reviewing the existing native document.");
      const run = await runRecordFlows({ kind: "on_create", source: "script" }, kind, key, { orgId: c.orgId, userId: c.actorId });
      if (run.failed) throw new SampleCompanyError(run.error ?? "The return scenario create Flow failed.");
      if (created.deferredUpdate) {
        const update = await runRecordFlows(created.deferredUpdate, kind, key, { orgId: c.orgId, userId: c.actorId });
        if (update.failed) throw new SampleCompanyError(update.error ?? "The return scenario update Flow failed.");
      }
      if (kind === "customer_invoice") {
        const release = await submitAndReleaseIfUngated(kind, key, c.actorId);
        if (release.flowError || release.gated || !release.autoApproved) throw new SampleCompanyError("The return source shipment requires independent approval; its company refresh has been rolled back.");
        await postDocument(key, { control: await loadRequiredControlAccounts(c.orgId) }, { audit: { actorId: c.actorId, source: "industry_demo_installation" } });
      }
    }
    const source = (await db.execute<{ id: string }>(sql`select m.id from inventory_movements m join document_lines l on l.org_id=m.org_id and l.id=m.document_line_id where m.org_id=${c.orgId} and l.document_id=${invoiceId} and m.kind='issue' and m.status='posted'`)).rows;
    if (source.length !== 1) throw new SampleCompanyError("The return example needs exactly one native posted shipment movement.");
    const authorization = await authorizeReturn(db, c.orgId, c.actorId, returnId, [{ lineNumber: 1, sourceIssueMovementId: source[0]!.id }], scope);
    if (authorization.status !== "approved") throw new SampleCompanyError("The return requires independent approval before demonstrating its receipt; review Flows before retrying.");
    if (n === 2) await receiveReturn(db, c.orgId, c.actorId, returnId, authorization.lines.map(line => ({ lineId: line.lineId, received: "1.00" })), scope);
    if (n === 3) await rejectReturn(db, c.orgId, c.actorId, returnId, "Customer confirmed the delivered specification and withdrew the synthetic return request", scope);
  }
}
