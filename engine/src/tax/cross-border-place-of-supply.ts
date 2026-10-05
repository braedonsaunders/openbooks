import { fromUnits, normalizeMoney, toUnits } from "../money/money.ts";

/**
 * Cross-border place of supply for B2C/B2B digital services and goods.
 *
 * B2C electronically supplied services follow EU Implementing Regulation
 * 282/2011 Articles 24b/24f: the customer's member state is established from
 * at least two items of non-contradictory evidence. Goods follow the ship-to
 * destination under the OSS distance-sales rules. A B2B customer whose VAT ID
 * the authority confirms takes the supply under reverse charge; an invalid or
 * still-unverified ID never silently becomes a B2C charge — the refusal names
 * the remedy and the operator decides.
 *
 * Pure: no database, no network. Evidence rows, validated IDs and OSS
 * registrations live in the caller's transaction; this module only judges.
 */

export class CrossBorderTaxError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "CrossBorderTaxError";
  }
}

export type SupplyKind = "digital_service" | "goods";
export type CustomerKind = "consumer" | "business";
export type EvidenceKind =
  | "billing_address"
  | "ip_country"
  | "card_bin_country"
  | "bank_country"
  | "sim_country"
  | "ship_to";
export type VatIdScheme = "vies" | "hmrc" | "abn" | "gst";
export type VatIdStatus = "valid" | "invalid" | "unverified";

export interface SupplyEvidence {
  kind: EvidenceKind;
  /** Derived ISO 3166-1 alpha-2 country code; raw IPs, PANs and BINs never reach this module. */
  country: string;
}

export interface BusinessVatId {
  scheme: VatIdScheme;
  value: string;
  status: VatIdStatus;
  /** Issuing state; defaults to the scheme's home (ABN → AU, HMRC → GB) or the VIES prefix. */
  country?: string;
}

export interface CrossBorderSupplyInput {
  supplyKind: SupplyKind;
  customerKind: CustomerKind;
  /** Supplier's state of establishment, ISO alpha-2. */
  sellerCountry: string;
  evidence: readonly SupplyEvidence[];
  businessVatId?: BusinessVatId | null;
  /** Frozen ship-to destination for goods, ISO alpha-2. */
  shipToCountry?: string | null;
  /** Highest precedence first; the first two distinct kinds decide. */
  evidencePrecedence?: readonly EvidenceKind[];
}

export type CrossBorderOutcome =
  | {
      outcome: "customer_country";
      country: string;
      evidence: EvidenceKind[];
      note: string;
    }
  | {
      outcome: "reverse_charge";
      country: string;
      vatId: string;
      evidence: EvidenceKind[];
      note: string;
    }
  | { outcome: "seller_country"; country: string; note: string }
  | { outcome: "export"; country: string; note: string };

const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);

/** Consumption states whose B2C rates and B2B reverse charge this module judges. */
const SUPPORTED_SELLERS: ReadonlySet<string> = new Set([
  ...EU_MEMBER_STATES, "GB", "AU", "CA",
]);

export const DEFAULT_EVIDENCE_PRECEDENCE: readonly EvidenceKind[] = [
  "billing_address",
  "ip_country",
  "card_bin_country",
  "bank_country",
  "sim_country",
  "ship_to",
];

const COUNTRY_RE = /^[A-Z]{2}$/;

function demandCountry(value: string, role: string): string {
  const country = value.trim().toUpperCase();
  if (!COUNTRY_RE.test(country)) {
    throw new CrossBorderTaxError(
      `provide the ${role} as an ISO 3166-1 alpha-2 country code (received "${value}"); correct the country before determining the place of supply`,
    );
  }
  return country;
}

function reverseChargeNote(input: {
  supplyKind: SupplyKind;
  scheme: VatIdScheme;
  country: string;
}): string {
  if (input.scheme === "hmrc") {
    return "Reverse charge — section 8 of the Value Added Tax Act 1994; the customer's HMRC-validated VAT ID is shown on the invoice";
  }
  if (input.supplyKind === "goods" && EU_MEMBER_STATES.has(input.country)) {
    return "Zero-rated intra-Community supply — Article 138 of Directive 2006/112/EC; the customer's VIES-validated VAT ID is shown on the invoice";
  }
  return "Reverse charge — Article 196 of Directive 2006/112/EC; the customer's validated VAT ID is shown on the invoice";
}

/** EUR 10,000 EU-wide cross-border B2C turnover, in ledger minor units (4dp). */
const EU_DISTANCE_THRESHOLD_MINOR = 100_000_000n;

export interface EuDistanceThresholdAssessment {
  crossed: boolean;
  /** Running year-to-date cross-border B2C turnover including this sale, EUR. */
  total: string;
  threshold: string;
  /** Set exactly when the sale crosses the threshold: the operator's next step. */
  alert: string | null;
}

/**
 * Monitor the EUR 10,000 EU-wide distance-sales threshold: add this sale's
 * EUR base to the year-to-date cross-border B2C turnover and report whether
 * the threshold is crossed. Amounts are exact EUR decimals; no float crosses
 * this boundary.
 */
export function assessEuDistanceThreshold(
  ytdCrossBorderB2CBase: string,
  currentSaleBase: string,
): EuDistanceThresholdAssessment {
  let ytd: bigint;
  let current: bigint;
  try {
    ytd = toUnits(normalizeMoney(ytdCrossBorderB2CBase));
    current = toUnits(normalizeMoney(currentSaleBase));
  } catch {
    throw new CrossBorderTaxError(
      "provide the year-to-date cross-border turnover and the sale amount as exact EUR decimals before assessing the distance-sales threshold",
    );
  }
  if (ytd < 0n || current < 0n) {
    throw new CrossBorderTaxError(
      "turnover and sale amounts cannot be negative when assessing the distance-sales threshold",
    );
  }
  const totalUnits = ytd + current;
  const crossed = totalUnits >= EU_DISTANCE_THRESHOLD_MINOR;
  return {
    crossed,
    total: fromUnits(totalUnits),
    threshold: "10000.0000",
    alert: crossed
      ? "Cross-border B2C turnover reached EUR 10,000: register for OSS (or in each member state of consumption) and charge destination rates from the next sale."
      : null,
  };
}

/**
 * Determine the place of supply and its treatment. Refusals carry status 422
 * and name the remedy; the caller raises them to the operator instead of
 * pricing the supply under a guessed country or a silent zero.
 */
export function determineCrossBorderSupply(
  input: CrossBorderSupplyInput,
): CrossBorderOutcome {
  const sellerCountry = demandCountry(input.sellerCountry, "seller country");
  if (!SUPPORTED_SELLERS.has(sellerCountry)) {
    throw new CrossBorderTaxError(
      `seller country ${sellerCountry} has no cross-border treatment configured; price this supply with an explicit domestic or manual tax treatment`,
    );
  }
  if (input.supplyKind !== "digital_service" && input.supplyKind !== "goods") {
    throw new CrossBorderTaxError(
      "classify the supply as a digital service or goods before determining the place of supply",
    );
  }

  const vatId = input.businessVatId ?? null;
  if (input.customerKind === "business" && vatId) {
    if (vatId.status === "invalid") {
      throw new CrossBorderTaxError(
        `the customer's ${vatId.scheme.toUpperCase()} ID "${vatId.value}" is invalid; correct the number on the customer record and revalidate, or remove it to sell as a consumer supply`,
      );
    }
    if (vatId.status === "unverified") {
      throw new CrossBorderTaxError(
        `the customer's ${vatId.scheme.toUpperCase()} ID "${vatId.value}" is unverified — the authority has not confirmed it; re-run validation, and while it stays unverified decide explicitly: wait for validation or charge the consumer rate`,
      );
    }
    const idCountry =
      vatId.country != null && vatId.country !== ""
        ? demandCountry(vatId.country, "VAT ID country")
        : vatId.scheme === "abn"
          ? "AU"
          : vatId.scheme === "hmrc"
            ? "GB"
            : demandCountry(vatId.value.slice(0, 2), "VAT ID country prefix");
    if (idCountry === sellerCountry) {
      return {
        outcome: "seller_country",
        country: sellerCountry,
        note: "Domestic business supply: the validated ID belongs to the seller's own state, so domestic tax rules apply",
      };
    }
    return {
      outcome: "reverse_charge",
      country: idCountry,
      vatId: vatId.value,
      evidence: [],
      note: reverseChargeNote({ supplyKind: input.supplyKind, scheme: vatId.scheme, country: idCountry }),
    };
  }

  if (input.supplyKind === "goods") {
    if (!input.shipToCountry) {
      throw new CrossBorderTaxError(
        "capture the ship-to destination before pricing cross-border goods; a billing address alone is not delivery evidence",
      );
    }
    const shipTo = demandCountry(input.shipToCountry, "ship-to country");
    if (shipTo === sellerCountry) {
      return {
        outcome: "seller_country",
        country: sellerCountry,
        note: "Domestic goods supply: the destination is the seller's own state, so domestic tax rules apply",
      };
    }
    if (!SUPPORTED_SELLERS.has(shipTo)) {
      return {
        outcome: "export",
        country: shipTo,
        note: "Zero-rated export outside the covered states; keep the shipping proof with the invoice",
      };
    }
    return {
      outcome: "customer_country",
      country: shipTo,
      evidence: ["ship_to"],
      note: "Goods place of supply is the destination state; charge its rate under OSS once the distance-sales threshold is crossed",
    };
  }

  // B2C digital services (and businesses without an ID): at least two
  // distinct, non-conflicting evidence kinds, ordered by precedence.
  const precedence = input.evidencePrecedence ?? DEFAULT_EVIDENCE_PRECEDENCE;
  const seen = new Map<EvidenceKind, string>();
  for (const piece of input.evidence) {
    if (!seen.has(piece.kind)) seen.set(piece.kind, demandCountry(piece.country, `${piece.kind} country`));
  }
  const ordered = [...seen.entries()].sort(
    ([a], [b]) => precedence.indexOf(a) - precedence.indexOf(b),
  );
  if (ordered.length < 2) {
    throw new CrossBorderTaxError(
      "collect at least two distinct place-of-supply signals (billing address, card country, IP country, bank country or SIM country) before pricing this digital supply; one signal cannot establish the customer's state",
    );
  }
  const [first, second] = [ordered[0]!, ordered[1]!];
  if (first[1] !== second[1]) {
    throw new CrossBorderTaxError(
      `place-of-supply evidence conflicts: ${first[0]} asserts ${first[1]} while ${second[0]} asserts ${second[1]}; choose the correct country on the document (the choice is recorded) or collect another signal`,
    );
  }
  const country = first[1];
  if (!SUPPORTED_SELLERS.has(country)) {
    // Outside the Union VAT area no EU VAT is due on the supply at all — this
    // is a judged out-of-scope outcome, never a silent zero. The note points
    // at the destination state's own digital rules, which the operator owns.
    return {
      outcome: "export",
      country,
      evidence: [first[0], second[0]],
      note: `B2C digital supply outside EU VAT scope (customer in ${country}); no EU VAT is due — apply the destination state's own digital-services rules where they exist`,
    };
  }
  if (country === sellerCountry) {
    return {
      outcome: "seller_country",
      country: sellerCountry,
      note: "Domestic digital supply: the evidence places the customer in the seller's own state, so domestic tax rules apply",
    };
  }
  return {
    outcome: "customer_country",
    country,
    evidence: [first[0], second[0]],
    note: `B2C digital supply taxed in the customer's state under Articles 24b/24f (${first[0]} + ${second[0]})`,
  };
}


