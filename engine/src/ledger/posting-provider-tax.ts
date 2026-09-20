import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { readTaxRateProviderConfig, readTaxQuoteForDocumentLine, sumComponentTax, type Address } from "../tax/rate-providers.ts";
import { computeLineTaxes, type TaxComponentConfig } from "../tax/tax.ts";
import { type Doc, type DocLine, type PostingDeps, type TaxPostingComponent, PostingError } from "./posting-rules.ts";
type ProviderTaxPlan = {
  line: DocLine;
  components: TaxPostingComponent[];
};

export function providerTaxDocumentKind(kind: string): boolean {
  return kind === "customer_invoice" || kind === "customer_credit" ||
    kind === "vendor_bill" || kind === "vendor_credit";
}

function addressFromRow(row: Record<string, unknown> | undefined): Address {
  return {
    line1: row?.line1 == null ? null : String(row.line1),
    city: row?.city == null ? null : String(row.city),
    region: row?.region == null ? null : String(row.region),
    postalCode: row?.postalCode == null ? null : String(row.postalCode),
    country: row?.country == null ? null : String(row.country),
  };
}

export async function defaultPartyAddress(
  orgId: string,
  partyId: string | null,
  shipping: boolean,
): Promise<Address> {
  if (!partyId) return {};
  const result = await db.execute<Record<string, unknown>>(sql`
    select line1, city, region, postal_code as "postalCode", country
      from addresses
     where org_id = ${orgId} and party_id = ${partyId}
     order by
       case when ${shipping} then is_default_shipping else is_default_billing end desc,
       case when ${shipping} then is_default_billing else is_default_shipping end desc,
       id asc
     limit 1
  `);
  return addressFromRow(result.rows[0]);
}

function providerRequestForLine(
  doc: Doc,
  line: DocLine,
  shipFrom: Address,
  shipTo: Address,
): import("../tax/rate-providers.ts").TaxQuoteRequest {
  const custom = (doc.custom ?? {}) as Record<string, unknown>;
  const customAddresses = (custom.taxProviderAddresses ?? {}) as Record<string, unknown>;
  const customFrom = (customAddresses.shipFrom ?? {}) as Address;
  const customTo = (customAddresses.shipTo ?? {}) as Address;
  const lineCustom = (line.custom ?? {}) as Record<string, unknown>;
  const itemCode = lineCustom.taxItemCode == null ? null : String(lineCustom.taxItemCode);
  return {
    taxableAmount: String(line.taxInputAmount ?? line.amount),
    currency: doc.currency,
    shipFrom: Object.keys(customFrom).length ? customFrom : shipFrom,
    shipTo: Object.keys(customTo).length ? customTo : shipTo,
    itemCode,
    quotedOn: doc.documentDate,
    documentLineId: line.id,
  };
}

export function taxConfigsFromEvidence(
  components: TaxPostingComponent[],
): TaxComponentConfig[] {
  return components.map((component) => ({
    taxCodeId: component.taxCodeId,
    sequence: component.sequence,
    ratePercent: component.ratePercent ?? "0",
    recoverablePercent: component.recoverablePercent ??
      (toUnits(component.taxAmount) === 0n
        ? "100"
        : fromUnits((toUnits(component.recoverableAmount) * 1_000_000n + toUnits(component.taxAmount) / 2n) /
            toUnits(component.taxAmount))),
    calculationType: component.calculationType,
    priceIncludesTax: component.priceIncludesTax ?? false,
    compoundOnPrevious: component.compoundOnPrevious ?? false,
    roundingScale: component.roundingScale ?? 2,
    collectedAccountId: component.collectedAccountId,
    paidAccountId: component.paidAccountId,
    withholdingAccountId: component.withholdingAccountId,
  }));
}

function sameProviderAddress(a: Address, b: Address): boolean {
  const keys: (keyof Address)[] = ["line1", "city", "region", "postalCode", "country"];
  return keys.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

/**
 * Resolve provider tax before posting by replaying the immutable quote and
 * calculation snapshot minted by the draft writer. Posting never performs
 * provider I/O or persists tax evidence: an absent, stale, or mismatched
 * snapshot fails closed before scripts, journals, or post-commit effects.
 */
export async function resolveProviderTaxPlans(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
): Promise<ProviderTaxPlan[]> {
  if (deps.migration || !providerTaxDocumentKind(doc.kind)) return [];
  const config = await readTaxRateProviderConfig(doc.orgId);
  // Manual rates are an explicit local provider. An administrator opting out
  // of external authority must never trigger a hidden HTTP call.
  if (!config?.isEnabled || !config.preferProvider || config.provider === "manual") return [];

  const partyAddress = await defaultPartyAddress(
    doc.orgId,
    doc.partyId,
    doc.kind === "customer_invoice" || doc.kind === "customer_credit",
  );
  const plans: ProviderTaxPlan[] = [];
  for (const line of lines) {
    if (!line.taxCodeId && !line.taxGroupId) continue;
    const existingComponents = deps.taxComponentsByLine?.get(line.id) ?? [];
    if (existingComponents.length === 0) {
      throw new PostingError(`line ${line.lineNumber} has a tax profile but no calculation evidence`);
    }
    const request = providerRequestForLine(
      doc,
      line,
      doc.kind === "vendor_bill" || doc.kind === "vendor_credit" ? partyAddress : {},
      doc.kind === "vendor_bill" || doc.kind === "vendor_credit" ? {} : partyAddress,
    );
    const persisted = await readTaxQuoteForDocumentLine(doc.orgId, line.id);
    if (!persisted) {
      throw new PostingError(
        `line ${line.lineNumber} has no immutable tax-provider quote; recalculate the draft before approval`,
      );
    }
    if (persisted.providerConfigId !== config.id || persisted.provider !== config.provider) {
      throw new PostingError(`line ${line.lineNumber} has ambiguous tax-provider provenance; refusing to post`);
    }
    if (
      persisted.quotedOn !== doc.documentDate ||
      persisted.currency !== (doc.currency ?? null) ||
      toUnits(persisted.taxableAmount) !== toUnits(request.taxableAmount) ||
      !sameProviderAddress(persisted.shipFrom, request.shipFrom) ||
      !sameProviderAddress(persisted.shipTo, request.shipTo)
    ) {
      throw new PostingError(`line ${line.lineNumber} persisted tax quote does not match the document; refusing to post`);
    }
    try {
      if (toUnits(persisted.taxAmount) !== toUnits(sumComponentTax(persisted.components))) {
        throw new Error("quote component total does not match headline tax");
      }
      if (persisted.provider !== config.provider || !Array.isArray(persisted.components)) {
        throw new Error("quote provider or components are invalid");
      }
    } catch (error) {
      throw new PostingError(
        `line ${line.lineNumber} has invalid immutable tax-provider evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const configs = taxConfigsFromEvidence(existingComponents);
    let calculated;
    try {
      calculated = computeLineTaxes(request.taxableAmount, configs, {
        overridden: true,
        taxAmount: persisted.taxAmount,
      });
    } catch (error) {
      throw new PostingError(
        `configured tax provider returned an invalid result for line ${line.lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Approved lines are immutable at the storage boundary. A document must
    // have been recalculated through the provider before approval; posting
    // revalidates the authoritative result instead of amending source facts.
    if (
      toUnits(calculated.netAmount) !== toUnits(line.amount) ||
      toUnits(calculated.taxTotal) !== toUnits(line.taxAmount ?? "0")
    ) {
      throw new PostingError(
        `configured tax provider changed the tax for line ${line.lineNumber}; recalculate the draft before approval`,
      );
    }
    plans.push({
      line,
      components: existingComponents,
    });
  }
  return plans;
}
