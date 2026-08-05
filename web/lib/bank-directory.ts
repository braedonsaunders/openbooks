/**
 * Global bank directory — a curated catalogue of common banks used to PRESET a
 * bank-feed connection: it fills in the provider (which aggregator typically
 * covers that bank), the country, and a brand colour so the Add-connection flow
 * is a two-click affair instead of a blank form. It is a convenience layer only;
 * the connection can always be configured manually, and any bank not listed is
 * handled by the "Other bank" tile.
 *
 * Pure data (no imports) so it is safe on both server and client.
 */

export type FeedProvider = "plaid" | "gocardless" | "truelayer" | "sftp" | "manual";

export interface BankDirectoryEntry {
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Brand hex for the avatar chip. */
  brandColor: string;
  /** The aggregator that usually covers this bank. */
  provider: FeedProvider;
}

export const BANK_COUNTRIES: { code: string; name: string }[] = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "NL", name: "Netherlands" },
  { code: "AU", name: "Australia" },
];

export const BANK_DIRECTORY: BankDirectoryEntry[] = [
  // United States — Plaid
  { id: "chase", name: "Chase", country: "US", brandColor: "#117ACA", provider: "plaid" },
  { id: "bofa", name: "Bank of America", country: "US", brandColor: "#E31837", provider: "plaid" },
  { id: "wells-fargo", name: "Wells Fargo", country: "US", brandColor: "#D71E28", provider: "plaid" },
  { id: "citi", name: "Citibank", country: "US", brandColor: "#056DAE", provider: "plaid" },
  { id: "us-bank", name: "U.S. Bank", country: "US", brandColor: "#0C2074", provider: "plaid" },
  { id: "pnc", name: "PNC Bank", country: "US", brandColor: "#F58025", provider: "plaid" },
  { id: "capital-one", name: "Capital One", country: "US", brandColor: "#004977", provider: "plaid" },
  { id: "td-us", name: "TD Bank (US)", country: "US", brandColor: "#54B848", provider: "plaid" },
  { id: "truist", name: "Truist", country: "US", brandColor: "#4C1D6E", provider: "plaid" },
  { id: "svb", name: "Silicon Valley Bank", country: "US", brandColor: "#003D6B", provider: "plaid" },
  { id: "mercury", name: "Mercury", country: "US", brandColor: "#5265FF", provider: "plaid" },

  // Canada — Plaid
  { id: "rbc", name: "RBC Royal Bank", country: "CA", brandColor: "#005DAA", provider: "plaid" },
  { id: "td-ca", name: "TD Canada Trust", country: "CA", brandColor: "#008A00", provider: "plaid" },
  { id: "scotiabank", name: "Scotiabank", country: "CA", brandColor: "#EC111A", provider: "plaid" },
  { id: "bmo", name: "BMO", country: "CA", brandColor: "#0075BE", provider: "plaid" },
  { id: "cibc", name: "CIBC", country: "CA", brandColor: "#B4131E", provider: "plaid" },
  { id: "national-bank", name: "National Bank", country: "CA", brandColor: "#E4002B", provider: "plaid" },
  { id: "desjardins", name: "Desjardins", country: "CA", brandColor: "#00874E", provider: "plaid" },

  // United Kingdom — TrueLayer
  { id: "barclays", name: "Barclays", country: "GB", brandColor: "#00AEEF", provider: "truelayer" },
  { id: "hsbc", name: "HSBC", country: "GB", brandColor: "#DB0011", provider: "truelayer" },
  { id: "lloyds", name: "Lloyds Bank", country: "GB", brandColor: "#024731", provider: "truelayer" },
  { id: "natwest", name: "NatWest", country: "GB", brandColor: "#5A287F", provider: "truelayer" },
  { id: "santander-uk", name: "Santander UK", country: "GB", brandColor: "#EC0000", provider: "truelayer" },
  { id: "monzo", name: "Monzo", country: "GB", brandColor: "#FF3464", provider: "truelayer" },
  { id: "starling", name: "Starling Bank", country: "GB", brandColor: "#6935FF", provider: "truelayer" },
  { id: "revolut", name: "Revolut", country: "GB", brandColor: "#0666EB", provider: "truelayer" },

  // Europe — GoCardless (Bank Account Data)
  { id: "deutsche-bank", name: "Deutsche Bank", country: "DE", brandColor: "#0018A8", provider: "gocardless" },
  { id: "commerzbank", name: "Commerzbank", country: "DE", brandColor: "#FFCC00", provider: "gocardless" },
  { id: "n26", name: "N26", country: "DE", brandColor: "#48AC98", provider: "gocardless" },
  { id: "bnp-paribas", name: "BNP Paribas", country: "FR", brandColor: "#00915A", provider: "gocardless" },
  { id: "credit-agricole", name: "Crédit Agricole", country: "FR", brandColor: "#007A33", provider: "gocardless" },
  { id: "ing", name: "ING", country: "NL", brandColor: "#FF6200", provider: "gocardless" },
  { id: "rabobank", name: "Rabobank", country: "NL", brandColor: "#FF6C00", provider: "gocardless" },
  { id: "santander-es", name: "Santander", country: "ES", brandColor: "#EC0000", provider: "gocardless" },
  { id: "bbva", name: "BBVA", country: "ES", brandColor: "#004481", provider: "gocardless" },
  { id: "unicredit", name: "UniCredit", country: "IT", brandColor: "#E2001A", provider: "gocardless" },
  { id: "aib", name: "Allied Irish Banks", country: "IE", brandColor: "#E4002B", provider: "gocardless" },

  // Australia — Plaid
  { id: "cba", name: "Commonwealth Bank", country: "AU", brandColor: "#FDB913", provider: "plaid" },
  { id: "westpac", name: "Westpac", country: "AU", brandColor: "#DA1710", provider: "plaid" },
  { id: "anz", name: "ANZ", country: "AU", brandColor: "#004165", provider: "plaid" },
  { id: "nab", name: "NAB", country: "AU", brandColor: "#E50000", provider: "plaid" },
];

export const PROVIDER_LABEL: Record<FeedProvider, string> = {
  plaid: "Plaid",
  gocardless: "GoCardless",
  truelayer: "TrueLayer",
  sftp: "SFTP file drop",
  manual: "Manual upload",
};

/** Fields a provider needs, so the Add flow can render the right inputs. */
export const PROVIDER_CREDENTIALS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  gocardless: [
    { key: "secretId", label: "Secret ID" },
    { key: "secretKey", label: "Secret key", secret: true },
  ],
  plaid: [
    { key: "clientId", label: "Client ID" },
    { key: "secret", label: "Secret", secret: true },
    { key: "accessToken", label: "Access token", secret: true },
    { key: "env", label: "Environment (production / sandbox)" },
  ],
  truelayer: [{ key: "accessToken", label: "Access token", secret: true }],
};

export function bankById(id: string): BankDirectoryEntry | undefined {
  return BANK_DIRECTORY.find((b) => b.id === id);
}
