import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createDocument } from "../ledger/document-write.ts";
import { isDocumentCreateKind } from "../records/document-kinds.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { runRecordFlows } from "../flows/index.ts";
import { operatingDocuments } from "./industry-operations.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/** Use the same validated draft writer, Flows and posting service as ordinary entry. */
export async function installOperatingDocuments(c: DemoContext, insertedDraftIds: ReadonlySet<string> = new Set()): Promise<void> {
  const control = await loadRequiredControlAccounts(c.orgId);
  for (const spec of operatingDocuments(c)) {
    let key = scenarioRecordId(c, "documents", spec.key);
    const matches = (await db.execute<{ id: string; kind: string; status: string }>(sql`
      select id,kind,status from documents where org_id=${c.orgId} and (id=${key} or (external_source='industry_demo' and external_ref=${spec.key}))
    `)).rows;
    if (matches.length > 1) throw new SampleCompanyError(`The demonstration identity ${spec.key} is ambiguous; review duplicate external references before refreshing.`);
    const existing = matches[0];
    if (existing && existing.kind !== spec.kind) throw new SampleCompanyError(`The demonstration identity ${spec.key} belongs to a different transaction type; review its provenance before refreshing.`);
    if (existing) key = existing.id;
    // Existing exploration work belongs to the operator, including drafts and reversals.
    if (existing && c.preserveExisting && !insertedDraftIds.has(existing.id)) continue;
    if (!existing) {
      const body = { partyId: ["transfer", "card_charge", "card_refund", "deposit"].includes(spec.kind) ? null : spec.partyId, documentDate: spec.documentDate,
        custom: ["cash_sale", "cash_refund"].includes(spec.kind) ? { tenders: [{ kind: "cash", accountId: scenarioRecordId(c, "accounts", "operations-bank"), amount: spec.amount, methodLabel: "Counter cash" }] } : ["check", "deposit", "card_charge", "card_refund"].includes(spec.kind) ? { controlAccountId: scenarioRecordId(c, "accounts", spec.kind.startsWith("card_") ? "operations-card" : "operations-bank") } : undefined,
        paymentCardId: spec.kind.startsWith("card_") ? scenarioRecordId(c, "payment_cards", "main") : undefined,
        memo: spec.description, externalSource: "industry_demo", externalRef: spec.key, lines: spec.kind === "transfer" ? [{ accountId: scenarioRecordId(c, "accounts", "operations-bank"), amount: spec.amount }, { accountId: scenarioRecordId(c, "accounts", "reserve-bank"), amount: spec.amount }] : [{ accountId: spec.accountId, description: spec.description,
          quantity: spec.quantity, unitPrice: spec.unitPrice, amount: spec.amount }] };
      if (isDocumentCreateKind(spec.kind)) {
        const created = await createDocument({ orgId: c.orgId, userId: c.actorId, kind: spec.kind,
          key, body, requestBody: body, subsidiaryId: c.subsidiaryId });
        if (created.status === "created") {
          const createFlows = await runRecordFlows({ kind: "on_create", source: "script" }, spec.kind, created.id, { orgId: c.orgId, userId: c.actorId });
          if (createFlows.failed) throw new SampleCompanyError(createFlows.error ?? "The operating draft create Flow failed; review its native run before retrying.");
          if (created.deferredUpdate) {
            const updateFlows = await runRecordFlows(created.deferredUpdate, spec.kind, created.id, { orgId: c.orgId, userId: c.actorId });
            if (updateFlows.failed) throw new SampleCompanyError(updateFlows.error ?? "The operating draft update Flow failed; review its native run before retrying.");
          }
        }
      } else {
        throw new SampleCompanyError(`The native authored draft ${spec.key} is missing; reinstall its scenario records before posting.`);
      }
    }
    if (!spec.post || existing?.status === "posted") continue;
    const released = await submitAndReleaseIfUngated(spec.kind, key, c.actorId);
    if (released.flowError || released.gated || !released.autoApproved) {
      throw new SampleCompanyError(`The ${spec.kind} demonstration requires independent approval. Review its Flow before refreshing; sample installation cannot approve its own gated work.`);
    }
    await postDocument(key, { control }, { audit: { actorId: c.actorId, source: "industry_demo_installation" } });
  }
}

export async function verifyOperatingDocuments(c: DemoContext): Promise<string[]> {
  const missing: string[] = [];
  const specs = operatingDocuments(c);
  const result = await db.execute<{ id: string; kind: string; status: string; lines: number; postedEntryId: string | null; externalRef: string | null; partyId: string | null; currency: string }>(sql`
    select d.id,d.kind,d.status,d.party_id as "partyId",d.currency,d.external_ref as "externalRef",d.posted_entry_id as "postedEntryId",
      (select count(*)::int from document_lines l where l.org_id=d.org_id and l.document_id=d.id) as lines
    from documents d where d.org_id=${c.orgId} and d.external_source='industry_demo' and d.external_ref in (${sql.join(specs.map(spec => sql`${spec.key}`), sql`, `)})
  `);
  const byId = new Map(result.rows.map(row => [row.externalRef, row]));
  for (const spec of specs) {
    const row = byId.get(spec.key);
    if (result.rows.filter(candidate => candidate.externalRef === spec.key).length > 1) missing.push(`ambiguous operating identity: ${spec.key}`);
    if (!row || row.kind !== spec.kind || row.lines < 1 || row.currency !== c.currency) missing.push(`operating transaction: ${spec.key}`);
    else if (!c.memberSample && !["transfer", "card_charge", "card_refund", "deposit"].includes(spec.kind) && row.partyId !== spec.partyId) missing.push(`operating counterparty: ${spec.key}`);
    else if (!c.memberSample && spec.post && (row.status !== "posted" || !row.postedEntryId)) missing.push(`posted operating transaction: ${spec.key}`);
  }
  return missing;
}
