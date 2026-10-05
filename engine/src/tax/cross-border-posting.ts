import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  determineCrossBorderSupply,
  CrossBorderTaxError,
  type CrossBorderOutcome,
  type CustomerKind,
  type SupplyKind,
} from "./cross-border-place-of-supply.ts";

/**
 * Posting boundary for cross-border sales: an elected B2C/B2B supply must
 * determine before it posts, and the verdict is frozen onto the document for
 * the OSS return. Conflicting evidence, an invalid ID or a still-unverified
 * ID refuses the post with the remedy — the operator chooses or collects
 * more, never a guessed country or a silent zero.
 *
 * Documents without the election keep their manual tax treatment: existing
 * codes, groups and overrides remain authoritative for their lines.
 */

export interface CrossBorderElection {
  supplyKind: SupplyKind;
  customerKind: CustomerKind;
  /**
   * A credit memo correcting an older supply names the corrected document.
   * The OSS return attributes the correction to that document's quarter; a
   * credit without it nets in its own period.
   */
  correctsDocument?: string;
}

export function parseCrossBorderElection(raw: unknown): CrossBorderElection | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new CrossBorderTaxError(
      "record the cross-border classification (a digital service or goods, for a consumer or a business) on the document before posting, or remove it to price with manual tax",
    );
  }
  const value = raw as Record<string, unknown>;
  if (
    (value.supplyKind !== "digital_service" && value.supplyKind !== "goods") ||
    (value.customerKind !== "consumer" && value.customerKind !== "business") ||
    Object.keys(value).some((key) => !["supplyKind", "customerKind", "correctsDocument"].includes(key))
  ) {
    throw new CrossBorderTaxError(
      "record the cross-border classification as exactly a digital service or goods, for a consumer or a business; other supplies need their explicit tax profile",
    );
  }
  if (value.correctsDocument !== undefined && typeof value.correctsDocument !== "string") {
    throw new CrossBorderTaxError(
      "name the corrected document by its identifier when a credit memo corrects an older supply",
    );
  }
  return {
    supplyKind: value.supplyKind,
    customerKind: value.customerKind,
    ...(typeof value.correctsDocument === "string" && value.correctsDocument
      ? { correctsDocument: value.correctsDocument }
      : {}),
  };
}

type PostingDocument = {
  kind: string;
  status: string;
  partyId: string | null;
  subsidiaryId: string | null;
  custom: Record<string, unknown> | null;
}

export interface CrossBorderVerdict {
  outcome: CrossBorderOutcome["outcome"];
  country: string;
  evidence: string[];
  vatId: string | null;
  decidedOn: string;
}

/**
 * Resolve the elected supply and, when persist is set, freeze the verdict on
 * the document. Prepare calls with persist off for an early refusal; the
 * commit transaction calls with persist on and its resolution is
 * authoritative. Returns null when the document carries no election.
 */
export async function assertCrossBorderSupplyEvidence(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  opts?: { persist?: boolean },
): Promise<CrossBorderVerdict | null> {
  const doc = (
    await tx.execute<PostingDocument>(sql`
      select kind, status, party_id as "partyId", subsidiary_id as "subsidiaryId", custom
        from documents where org_id = ${orgId} and id = ${documentId}`)
  ).rows[0];
  if (!doc) return null;
  const election = parseCrossBorderElection(doc.custom?.crossBorder);
  if (!election) return null;
  if (!(await orgFeatureEnabled(orgId, "crossBorderTax", tx))) {
    throw new CrossBorderTaxError(
      "enable Cross-border tax on Company Settings → Features before posting a cross-border supply; turning it off keeps existing evidence but refuses new cross-border posts",
    );
  }
  if (doc.kind !== "customer_invoice" && doc.kind !== "customer_credit") {
    throw new CrossBorderTaxError(
      "elect cross-border treatment only on a customer invoice or credit; other document kinds require their explicit tax profile",
    );
  }

  const sellerRows = doc.subsidiaryId
    ? (
        await tx.execute<{ country: string | null }>(sql`
          select country from subsidiaries where org_id = ${orgId} and id = ${doc.subsidiaryId}`)
      ).rows
    : (
        await tx.execute<{ country: string | null }>(sql`
          select country from orgs where id = ${orgId}`)
      ).rows;
  const sellerCountry = sellerRows[0]?.country;
  if (!sellerCountry) {
    throw new CrossBorderTaxError(
      "set the selling legal entity (and its country) before posting a cross-border supply",
    );
  }

  const evidence = (
    await tx.execute<{ kind: string; countryCode: string }>(sql`
      select kind, country_code as "countryCode" from document_supply_evidence
       where org_id = ${orgId} and document_id = ${documentId}`)
  ).rows.map((row) => ({ kind: row.kind, country: row.countryCode }));

  let businessVatId: { scheme: "vies" | "hmrc" | "abn" | "gst"; value: string; status: "valid" | "invalid" | "unverified" } | null =
    null;
  if (election.customerKind === "business" && doc.partyId) {
    const idRow = (
      await tx.execute<{ scheme: string; value: string; status: string }>(sql`
        select scheme, value, status from party_tax_ids
         where org_id = ${orgId} and party_id = ${doc.partyId} and is_active
         order by status = 'valid' desc, checked_at desc nulls last, created_at desc
         limit 1`)
    ).rows[0];
    if (idRow) {
      businessVatId = {
        scheme: idRow.scheme as "vies" | "hmrc" | "abn" | "gst",
        value: idRow.value,
        status: idRow.status as "valid" | "invalid" | "unverified",
      };
    }
  }

  const shipTo = (
    await tx.execute<{ country: string | null }>(sql`
      select ship_to_country as country from documents where org_id = ${orgId} and id = ${documentId}`)
  ).rows[0]?.country;

  const outcome = determineCrossBorderSupply({
    supplyKind: election.supplyKind,
    customerKind: election.customerKind,
    sellerCountry,
    evidence: evidence.map((row) => ({
      kind: row.kind as "billing_address" | "ip_country" | "card_bin_country" | "bank_country" | "sim_country" | "ship_to",
      country: row.country,
    })),
    businessVatId,
    shipToCountry: shipTo,
  });

  if (outcome.outcome === "reverse_charge") {
    const offending = (
      await tx.execute<{ n: string }>(sql`
        select count(*)::text as n
          from document_line_tax_components component
          join document_lines line on line.org_id = component.org_id and line.id = component.document_line_id
         where component.org_id = ${orgId} and line.document_id = ${documentId}
           and component.calculation_type <> 'reverse_charge'`)
    ).rows[0]?.n;
    if (offending !== "0") {
      throw new CrossBorderTaxError(
        `reverse charge applies (${outcome.note}); mark every line with the reverse-charge tax treatment before posting`,
      );
    }
  }

  const verdict: CrossBorderVerdict = {
    outcome: outcome.outcome,
    country: outcome.country,
    evidence: outcome.outcome === "seller_country" ? [] : (outcome.evidence as string[]),
    vatId: outcome.outcome === "reverse_charge" ? outcome.vatId : null,
    decidedOn: new Date().toISOString().slice(0, 10),
  };
  if (opts?.persist) {
    const saved = await tx.execute(sql`
      update documents
         set custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object('crossBorderSupply', ${JSON.stringify(verdict)}::jsonb)
       where org_id = ${orgId} and id = ${documentId}
       returning 1
    `);
    // A write that matches zero rows is a failure: the verdict is the OSS
    // return's only record of this supply, so losing it is losing the return.
    if (saved.rows.length !== 1) {
      throw new CrossBorderTaxError(
        "the cross-border verdict could not be frozen on the document — reload it before posting",
      );
    }
  }
  return verdict;
}
