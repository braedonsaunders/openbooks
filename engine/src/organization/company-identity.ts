/**
 * The company's own legal identity: registered address, legal form, tax
 * classification and the tax/registration identifiers it files and invoices
 * under. Pure and client-safe — the Company & Accounting form validates with
 * the same rules the settings write enforces, and printed documents read the
 * same canonical forms.
 *
 * Identifiers are scheme-keyed (`us_ein`, `ca_gst_hst`, `eu_vat`…), each with
 * the jurisdictions it belongs to, a canonical form and a structural check
 * (length, pattern and, where the issuing authority publishes one, its check
 * digit). A structural check proves the number is well formed, never that the
 * authority issued it.
 */

export const LEGAL_FORMS = [
  "sole_proprietorship",
  "general_partnership",
  "limited_partnership",
  "llp",
  "llc",
  "corporation",
  "cooperative",
  "nonprofit",
  "trust",
  "other",
] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const TAX_CLASSIFICATIONS = [
  "individual",
  "partnership",
  "corporation",
  "s_corporation",
  "tax_exempt",
  "trust",
  "other",
] as const;
export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number];

/**
 * How each legal form may be taxed. An LLC may be disregarded (taxed with its
 * owner), a partnership, or elect corporate treatment; a corporation is taxed
 * as one (or, in the US, may elect S status); the remaining forms have one
 * treatment.
 */
const CLASSIFICATIONS_BY_FORM: Readonly<Record<LegalForm, readonly TaxClassification[]>> = {
  sole_proprietorship: ["individual"],
  general_partnership: ["partnership"],
  limited_partnership: ["partnership"],
  llp: ["partnership"],
  llc: ["individual", "partnership", "corporation", "s_corporation"],
  corporation: ["corporation", "s_corporation"],
  cooperative: ["corporation", "partnership", "other"],
  nonprofit: ["tax_exempt", "corporation"],
  trust: ["trust"],
  other: [...TAX_CLASSIFICATIONS],
};

/** S-corporation status is an election under US federal tax law only. */
const COUNTRY_ONLY_CLASSIFICATIONS: Partial<Record<TaxClassification, readonly string[]>> = {
  s_corporation: ["US"],
};

export function isLegalForm(value: unknown): value is LegalForm {
  return typeof value === "string" && (LEGAL_FORMS as readonly string[]).includes(value);
}

export function isTaxClassification(value: unknown): value is TaxClassification {
  return typeof value === "string" && (TAX_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** The tax classifications open to a legal form in a country. */
export function taxClassificationsFor(form: LegalForm | null, country: string): TaxClassification[] {
  const allowed = form ? CLASSIFICATIONS_BY_FORM[form] : TAX_CLASSIFICATIONS;
  return allowed.filter((classification) => {
    const countries = COUNTRY_ONLY_CLASSIFICATIONS[classification];
    return !countries || countries.includes(country);
  });
}

// ---------------------------------------------------------------------------
// Registered address
// ---------------------------------------------------------------------------

/** The registered address, in the shape of the party address model. */
export interface CompanyAddress {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export const EMPTY_COMPANY_ADDRESS: Readonly<CompanyAddress> = {
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
};

const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;
const ADDRESS_FIELD_MAX = 200;

/** Stored address → the full shape, blanks for absent parts; null when none is stored. */
export function readCompanyAddress(value: unknown): CompanyAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const address = Object.fromEntries(
    ADDRESS_FIELDS.map((field) => [field, typeof record[field] === "string" ? (record[field] as string) : ""]),
  ) as unknown as CompanyAddress;
  return ADDRESS_FIELDS.some((field) => address[field]) ? address : null;
}

export type AddressProblem =
  | { field: keyof CompanyAddress; reason: "too_long" | "invalid_country" }
  | { field: "line1" | "city"; reason: "required" };

/**
 * Validate and trim an address. An entirely blank address clears it (null);
 * a partial one must at least name a street line and a city so it can print
 * as a mailing address.
 */
export function normalizeCompanyAddress(
  value: unknown,
  isCountry: (code: string) => boolean,
): { ok: true; address: CompanyAddress | null } | { ok: false; problem: AddressProblem } {
  if (value === null) return { ok: true, address: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: { field: "line1", reason: "required" } };
  }
  const record = value as Record<string, unknown>;
  const address = {} as CompanyAddress;
  for (const field of ADDRESS_FIELDS) {
    const raw = record[field];
    const text = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (text.length > ADDRESS_FIELD_MAX) return { ok: false, problem: { field, reason: "too_long" } };
    address[field] = field === "country" || field === "postalCode" ? text.toUpperCase() : text;
  }
  if (ADDRESS_FIELDS.every((field) => !address[field])) return { ok: true, address: null };
  if (!address.line1) return { ok: false, problem: { field: "line1", reason: "required" } };
  if (!address.city) return { ok: false, problem: { field: "city", reason: "required" } };
  if (!isCountry(address.country)) return { ok: false, problem: { field: "country", reason: "invalid_country" } };
  return { ok: true, address };
}

/** One printable line: "400 King St W, Suite 300, Toronto, ON M5V 1K2, CA". */
export function formatCompanyAddress(address: CompanyAddress | null): string {
  if (!address) return "";
  const locality = [address.city, [address.region, address.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [address.line1, address.line2, locality, address.country].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Tax and registration identifiers
// ---------------------------------------------------------------------------

export const EU_VAT_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

/** VAT number prefix per EU member state (Greece files under EL). */
function euVatPrefix(country: string): string {
  return country === "GR" ? "EL" : country;
}

export interface TaxIdScheme {
  key: string;
  /** Short printed label ("EIN", "GST/HST"), for documents and audit. */
  printLabel: string;
  /** Countries the scheme is issued in; empty = any country. */
  countries: readonly string[];
  /** An example in canonical form, for placeholders. */
  example: string;
  /** Canonical form, or null when the value is not structurally valid. */
  normalize: (raw: string, country: string) => string | null;
}

function compact(raw: string): string {
  return raw.replace(/[\s.\-_/]/g, "").toUpperCase();
}

/** Luhn mod-10 check over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Australian Business Number checksum (ATO published weighting). */
function abnValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const values = digits.split("").map(Number);
  values[0] = values[0]! - 1;
  return values.reduce((sum, digit, index) => sum + digit * weights[index]!, 0) % 89 === 0;
}

export const TAX_ID_SCHEMES: readonly TaxIdScheme[] = [
  {
    key: "us_ein",
    printLabel: "EIN",
    countries: ["US"],
    example: "12-3456789",
    normalize: (raw) => {
      const digits = compact(raw);
      if (!/^\d{9}$/.test(digits) || digits.startsWith("00")) return null;
      return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    },
  },
  {
    key: "ca_bn",
    printLabel: "BN",
    countries: ["CA"],
    example: "123456782",
    normalize: (raw) => {
      const digits = compact(raw);
      return /^\d{9}$/.test(digits) && luhnValid(digits) ? digits : null;
    },
  },
  {
    key: "ca_gst_hst",
    printLabel: "GST/HST",
    countries: ["CA"],
    example: "123456782RT0001",
    normalize: (raw) => {
      const value = compact(raw);
      const match = /^(\d{9})RT(\d{4})$/.exec(value);
      return match && luhnValid(match[1]!) ? value : null;
    },
  },
  {
    key: "ca_qst",
    printLabel: "QST",
    countries: ["CA"],
    example: "1234567890TQ0001",
    normalize: (raw) => {
      const value = compact(raw);
      return /^\d{10}TQ\d{4}$/.test(value) ? value : null;
    },
  },
  {
    key: "gb_vat",
    printLabel: "VAT",
    countries: ["GB"],
    example: "GB123456789",
    normalize: (raw) => {
      const value = compact(raw);
      const vrn = value.startsWith("GB") ? value : `GB${value}`;
      return /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/.test(vrn) ? vrn : null;
    },
  },
  {
    key: "gb_crn",
    printLabel: "Company no.",
    countries: ["GB"],
    example: "01234567",
    normalize: (raw) => {
      const value = compact(raw);
      return /^([A-Z]{2}\d{6}|\d{8})$/.test(value) ? value : null;
    },
  },
  {
    key: "eu_vat",
    printLabel: "VAT",
    countries: EU_VAT_COUNTRIES,
    example: "DE123456789",
    normalize: (raw, country) => {
      const prefix = euVatPrefix(country);
      const value = compact(raw);
      const withPrefix = /^[A-Z]{2}/.test(value) ? value : `${prefix}${value}`;
      return withPrefix.startsWith(prefix) && /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(withPrefix) ? withPrefix : null;
    },
  },
  {
    key: "au_abn",
    printLabel: "ABN",
    countries: ["AU"],
    example: "51824753556",
    normalize: (raw) => {
      const digits = compact(raw);
      return abnValid(digits) ? digits : null;
    },
  },
  {
    key: "tax_id",
    printLabel: "Tax ID",
    countries: [],
    example: "",
    normalize: (raw) => {
      const value = raw.trim().replace(/\s+/g, " ").toUpperCase();
      return /^[A-Z0-9][A-Z0-9 .\-/]{1,39}$/.test(value) ? value : null;
    },
  },
  {
    key: "registration",
    printLabel: "Reg. no.",
    countries: [],
    example: "",
    normalize: (raw) => {
      const value = raw.trim().replace(/\s+/g, " ").toUpperCase();
      return /^[A-Z0-9][A-Z0-9 .\-/]{0,39}$/.test(value) ? value : null;
    },
  },
];

const SCHEME_BY_KEY = new Map(TAX_ID_SCHEMES.map((scheme) => [scheme.key, scheme]));

export function taxIdScheme(key: string): TaxIdScheme | undefined {
  return SCHEME_BY_KEY.get(key);
}

/** Jurisdiction schemes that already are the country's VAT or company
 *  registration number, replacing the generic one. */
const VAT_SCHEMES = new Set(["gb_vat", "eu_vat"]);
const REGISTRATION_SCHEMES = new Set(["gb_crn"]);

/**
 * The identifiers a company in `country` records: its own jurisdiction's
 * schemes, then the generic tax and registration numbers unless the
 * jurisdiction's own scheme already is that number.
 */
export function taxIdSchemesFor(country: string): TaxIdScheme[] {
  const own = TAX_ID_SCHEMES.filter((scheme) => scheme.countries.includes(country));
  const ownVat = own.some((scheme) => VAT_SCHEMES.has(scheme.key));
  const ownRegistration = own.some((scheme) => REGISTRATION_SCHEMES.has(scheme.key));
  const generic = TAX_ID_SCHEMES.filter(
    (scheme) => (scheme.key === "tax_id" && !ownVat) || (scheme.key === "registration" && !ownRegistration),
  );
  return [...own, ...generic];
}

export type TaxIdProblem = { scheme: string; reason: "unknown_scheme" | "not_in_country" | "invalid" };

/**
 * Validate a full identifier map for a company in `country`. Blank values
 * remove the identifier. A scheme of another jurisdiction is refused unless
 * the stored value is resubmitted unchanged (a company that moved keeps the
 * evidence it already holds until an operator removes it).
 */
export function normalizeTaxIds(
  input: Record<string, unknown>,
  country: string,
  stored: Readonly<Record<string, string>>,
): { ok: true; taxIds: Record<string, string> } | { ok: false; problem: TaxIdProblem } {
  const allowed = new Set(taxIdSchemesFor(country).map((scheme) => scheme.key));
  const taxIds: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const scheme = taxIdScheme(key);
    if (!scheme) return { ok: false, problem: { scheme: key, reason: "unknown_scheme" } };
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    if (typeof raw !== "string") return { ok: false, problem: { scheme: key, reason: "invalid" } };
    if (!allowed.has(key)) {
      if (stored[key] === raw) {
        taxIds[key] = raw;
        continue;
      }
      return { ok: false, problem: { scheme: key, reason: "not_in_country" } };
    }
    const canonical = scheme.normalize(raw, country);
    if (!canonical) return { ok: false, problem: { scheme: key, reason: "invalid" } };
    taxIds[key] = canonical;
  }
  return { ok: true, taxIds };
}

/** Stored identifiers that name a known scheme with a string value. */
export function readTaxIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => SCHEME_BY_KEY.has(entry[0]) && typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

/** "EIN 12-3456789 · GST/HST 123456782RT0001", in scheme registry order. */
export function formatTaxIds(taxIds: Readonly<Record<string, string>>): string {
  return TAX_ID_SCHEMES.filter((scheme) => taxIds[scheme.key])
    .map((scheme) => `${scheme.printLabel} ${taxIds[scheme.key]}`)
    .join(" · ");
}

/** The identifier an information return names its payer by: the federal
 *  employer or business number, else the first identifier on file. */
export function payerTaxIdentifier(taxIds: Readonly<Record<string, string>>): string | null {
  return taxIds.us_ein ?? taxIds.ca_bn ?? TAX_ID_SCHEMES.map((scheme) => taxIds[scheme.key]).find(Boolean) ?? null;
}
