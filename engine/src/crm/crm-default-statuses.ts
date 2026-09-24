/** Dependency-free canonical CRM statuses used both for seeding and display. */
export const DEFAULT_ACCOUNT_STATUSES = [
  ["lead", "new", "New", false, false, true],
  ["lead", "working", "Working", false, false, false],
  ["lead", "qualified", "Qualified", true, false, false],
  ["lead", "disqualified", "Disqualified", false, true, false],
  ["prospect", "open", "Open", true, false, true],
  ["prospect", "nurturing", "Nurturing", true, false, false],
  ["prospect", "closed_lost", "Closed lost", false, true, false],
  ["customer", "active", "Active", true, false, true],
  ["customer", "inactive", "Inactive", false, true, false],
] as const;

export const DEFAULT_OPPORTUNITY_STATUSES = [
  ["qualification", "Qualification", 10, "upside", false, false, true, false],
  ["discovery", "Discovery", 25, "upside", false, false, false, false],
  ["proposal", "Proposal", 50, "most_likely", false, false, false, false],
  ["negotiation", "Negotiation", 75, "most_likely", false, false, false, false],
  ["closed_won", "Closed won", 100, "worst_case", true, true, false, false],
  ["closed_lost", "Closed lost", 0, "omitted", true, false, false, true],
] as const;

function catalogKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export const SEEDED_ACCOUNT_STATUS_NAMES: Record<string, string> = Object.fromEntries(
  DEFAULT_ACCOUNT_STATUSES.map(([, key, name]) => [name, catalogKey(key)]),
);

export const SEEDED_OPPORTUNITY_STATUS_NAMES: Record<string, string> = Object.fromEntries(
  DEFAULT_OPPORTUNITY_STATUSES.map(([key, name]) => [name, catalogKey(key)]),
);
