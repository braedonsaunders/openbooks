import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  normalizeVatId,
  type VatAuthorityScheme,
} from "../connectors/vat-validation.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";
import { parseCrossBorderElection } from "./cross-border-posting.ts";
import { validatePartyTaxId, type TaxIdCredentials } from "./vat-id-validation.ts";

/**
 * Operator writes for cross-border tax: recording customer tax IDs and the
 * per-document evidence that the posting boundary judges. Every write holds
 * the org feature lock, so switching the feature off refuses new records
 * while keeping existing data.
 */

const EVIDENCE_KINDS = [
  "billing_address",
  "ip_country",
  "card_bin_country",
  "bank_country",
  "sim_country",
  "ship_to",
] as const;

export interface SavePartyTaxIdInput {
  partyId: string;
  scheme: VatAuthorityScheme;
  value: string;
}

export async function savePartyTaxId(
  tx: SqlExecutor,
  orgId: string,
  input: SavePartyTaxIdInput,
  actorId: string | null,
): Promise<{ id: string; status: string }> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "crossBorderTax"))) {
    throw new CrossBorderTaxError(
      "enable Cross-border tax on Company Settings → Features before recording customer tax IDs",
    );
  }
  const party = (
    await tx.execute<{ id: string }>(sql`
      select id from parties where org_id = ${orgId} and id = ${input.partyId}`)
  ).rows[0];
  if (!party) {
    throw new CrossBorderTaxError("this customer belongs to another organization; reload the customer record");
  }
  const value = normalizeVatId(input.scheme, input.value);
  // Re-adding the number already on file is the same fact, not a second
  // row: history is per value, so return the standing row instead.
  const existing = (
    await tx.execute<{ id: string; status: string }>(sql`
      select id, status from party_tax_ids
       where org_id = ${orgId} and party_id = ${input.partyId} and scheme = ${input.scheme} and value = ${value}
         and is_active`)
  ).rows[0];
  if (existing) return { id: existing.id, status: existing.status };
  const saved = (
    await tx.execute<{ id: string }>(sql`
      insert into party_tax_ids (org_id, party_id, scheme, value, status, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.scheme}, ${value}, 'unverified', ${actorId}, ${actorId})
      returning id`)
  ).rows[0];
  if (!saved) {
    throw new CrossBorderTaxError("the tax ID could not be saved — reload the customer record before retrying");
  }
  await tx.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'party_tax_ids', ${saved.id}, 'create',
      ${JSON.stringify({
        event: "tax_id_recorded",
        after: { scheme: input.scheme },
        reason: "operator recorded a customer tax ID for validation",
      })}::jsonb, ${actorId})`);
  return { id: saved.id, status: "unverified" };
}

export interface SupplyEvidenceInput {
  kind: (typeof EVIDENCE_KINDS)[number];
  country: string;
  source: string;
}

export interface RecordSupplyEvidenceInput {
  election: {
    supplyKind: "digital_service" | "goods";
    customerKind: "consumer" | "business";
    /**
     * A credit memo names the posted invoice it corrects (null clears it);
     * absent leaves the relationship untouched, so evidence re-saves never
     * wipe a correction the operator did not change.
     */
    correctsDocumentId?: string | null;
  };
  evidence: SupplyEvidenceInput[];
}

const DOCUMENT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Replace a draft credit memo's correction relationship in the same unit as
 * its election: the corrected invoice is validated (posted customer invoice
 * of the same customer in this organization) and the single `corrects`
 * document_links edge is rewritten. A null pointer clears the relationship.
 * Every refusal names the remedy; no refusal leaves a half-written edge.
 */
async function replaceCorrectionLink(
  tx: SqlExecutor,
  orgId: string,
  creditId: string,
  creditPartyId: string | null,
  correctsDocumentId: string | null,
  actorId: string | null,
): Promise<void> {
  if (correctsDocumentId === null) {
    await tx.execute(sql`
      delete from document_links
       where org_id = ${orgId} and from_document_id = ${creditId} and link_type = 'corrects'`);
    return;
  }
  if (!DOCUMENT_ID_PATTERN.test(correctsDocumentId)) {
    throw new CrossBorderTaxError(
      "name the corrected invoice by choosing it from this organization's posted invoices — a typed identifier cannot be verified",
    );
  }
  if (correctsDocumentId === creditId) {
    throw new CrossBorderTaxError("a credit memo cannot correct itself — choose the posted invoice it corrects");
  }
  const target = (
    await tx.execute<{ kind: string; status: string; partyId: string | null }>(sql`
      select kind, status, party_id as "partyId" from documents
       where org_id = ${orgId} and id = ${correctsDocumentId}`)
  ).rows[0];
  if (!target) {
    throw new CrossBorderTaxError(
      "the corrected invoice belongs to another organization; choose a posted customer invoice from this organization",
    );
  }
  if (target.kind !== "customer_invoice") {
    throw new CrossBorderTaxError(
      "only correct a customer invoice with a credit memo — choose the posted invoice this credit corrects",
    );
  }
  if (target.status !== "posted") {
    throw new CrossBorderTaxError(
      "post the corrected invoice first; a correction attributes to its filed quarter, which a draft does not have yet",
    );
  }
  if (creditPartyId && target.partyId !== creditPartyId) {
    throw new CrossBorderTaxError(
      "correct an invoice for the same customer as the credit memo — choose the customer's own posted invoice",
    );
  }
  await tx.execute(sql`
    delete from document_links
     where org_id = ${orgId} and from_document_id = ${creditId} and link_type = 'corrects'`);
  const edge = (
    await tx.execute<{ id: string }>(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
      values (${orgId}, ${creditId}, ${correctsDocumentId}, 'corrects', ${actorId}, ${actorId})
      returning id`)
  ).rows[0];
  if (!edge) {
    throw new CrossBorderTaxError("the correction could not be recorded — reload the credit memo before retrying");
  }
  await tx.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'document_links', ${edge.id}, 'insert',
      ${JSON.stringify({
        event: "correction_recorded",
        linkType: "corrects",
        fromDocumentId: creditId,
        toDocumentId: correctsDocumentId,
        reason: "operator named the corrected invoice on the credit memo",
      })}::jsonb, ${actorId})`);
}

/**
 * Replace a draft document's cross-border election and evidence signals in
 * one unit: the election is validated, existing draft evidence is recollected
 * (the guard permits draft rewrites), and the new signals are stored. A
 * credit memo's corrected invoice is recorded as a `corrects` document
 * relationship beside the election, never as an identifier string in custom
 * JSON. Posted documents refuse through the evidence guard itself.
 */
export async function recordSupplyEvidence(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  input: RecordSupplyEvidenceInput,
  actorId: string | null,
): Promise<{ evidence: number }> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "crossBorderTax"))) {
    throw new CrossBorderTaxError(
      "enable Cross-border tax on Company Settings → Features before recording supply evidence",
    );
  }
  const election = parseCrossBorderElection(input.election);
  if (!election) {
    throw new CrossBorderTaxError(
      "record the cross-border classification (a digital service or goods, for a consumer or a business) before recording evidence",
    );
  }
  const doc = (
    await tx.execute<{ kind: string; status: string; partyId: string | null }>(sql`
      select kind, status, party_id as "partyId" from documents where org_id = ${orgId} and id = ${documentId}`)
  ).rows[0];
  if (!doc) throw new CrossBorderTaxError("this document belongs to another organization; reload it before recording evidence");
  if (doc.kind !== "customer_invoice" && doc.kind !== "customer_credit") {
    throw new CrossBorderTaxError("record supply evidence only on a customer invoice or credit");
  }
  if (doc.status !== "draft") {
    throw new CrossBorderTaxError(
      "supply evidence is collected while the document is a draft; return the document to draft to recollect it",
    );
  }
  if (doc.kind !== "customer_credit" && election.correctsDocumentId !== undefined) {
    throw new CrossBorderTaxError(
      "only a credit memo names a corrected document; an invoice carries its own supply and corrects nothing",
    );
  }
  if (doc.kind === "customer_credit" && election.correctsDocumentId !== undefined) {
    await replaceCorrectionLink(tx, orgId, documentId, doc.partyId, election.correctsDocumentId, actorId);
  }
  const seen = new Set<string>();
  for (const piece of input.evidence) {
    if (!EVIDENCE_KINDS.includes(piece.kind)) {
      throw new CrossBorderTaxError(
        `unknown evidence kind "${piece.kind}"; use billing address, IP, card, bank, SIM or ship-to signals`,
      );
    }
    const country = piece.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new CrossBorderTaxError(
        `record each signal as an ISO 3166-1 alpha-2 country code (received "${piece.country}"); raw addresses and identifiers are never stored`,
      );
    }
    if (!piece.source.trim() || piece.source.length > 40) {
      throw new CrossBorderTaxError("name the observing system for each signal in 40 characters or fewer");
    }
    seen.add(piece.kind);
  }
  await tx.execute(sql`delete from document_supply_evidence where org_id = ${orgId} and document_id = ${documentId}`);
  for (const piece of input.evidence) {
    await tx.execute(sql`
      insert into document_supply_evidence (org_id, document_id, kind, country_code, source, observed_on, created_by)
      values (${orgId}, ${documentId}, ${piece.kind}, ${piece.country.trim().toUpperCase()}, ${piece.source.trim()}, current_date, ${actorId})`);
  }
  const saved = await tx.execute(sql`
    update documents
       set custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object('crossBorder', ${JSON.stringify({ supplyKind: election.supplyKind, customerKind: election.customerKind })}::jsonb)
     where org_id = ${orgId} and id = ${documentId}
     returning 1
  `);
  if (saved.rows.length !== 1) {
    throw new CrossBorderTaxError("the evidence could not be saved — reload the document before retrying");
  }
  return { evidence: input.evidence.length };
}

export interface ValidateStoredTaxIdOptions {
  credentials?: TaxIdCredentials;
  transport?: typeof fetch;
  revalidateAfterDays?: number;
}

/**
 * Validate the stored row against its authority inside the caller's unit of
 * work. Authority outages keep the row unverified and raise, so the drawer
 * shows the outage instead of a verdict nobody confirmed.
 */
export async function validateStoredTaxId(
  orgId: string,
  rowId: string,
  actorId: string | null,
  options: ValidateStoredTaxIdOptions = {},
  tx: SqlExecutor = db,
): Promise<{ id: string; status: string; consultationNumber: string | null }> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "crossBorderTax"))) {
    throw new CrossBorderTaxError(
      "enable Cross-border tax on Company Settings → Features before validating tax IDs",
    );
  }
  const outcome = await validatePartyTaxId(tx, orgId, rowId, {
    actorId,
    credentials: options.credentials,
    transport: options.transport,
    revalidateAfterDays: options.revalidateAfterDays,
    reason: "operator validation",
  });
  return { id: outcome.rowId, status: outcome.status, consultationNumber: outcome.consultationNumber };
}
