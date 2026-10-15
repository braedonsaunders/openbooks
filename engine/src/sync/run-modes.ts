/**
 * Run modes beyond migrate, preflight and mirror that only some sources
 * implement. The run command and its callers ask this instead of naming a
 * source, so the capability has one declaration.
 */
const SOURCE_ONLY_RUN_MODES: Record<string, readonly string[]> = {
  project_financials: ["netsuite"],
  attachments: ["netsuite"],
  targeted_repair: ["netsuite"],
};

/** A targeted source repair names a bounded, exact upstream transaction set. */
export function validateTargetedRepairSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error("Name between 1 and 500 source transaction IDs for a targeted repair.");
  }
  if (value.some((ref) => typeof ref !== "string" || !/^[1-9]\d{0,39}$/.test(ref))) {
    throw new Error("Source transaction IDs must be positive whole-number text without spaces.");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("Each source transaction ID must appear once in the targeted repair.");
  }
  return [...value];
}

export function sourceSupportsRunMode(source: string, mode: string): boolean {
  const sources = SOURCE_ONLY_RUN_MODES[mode];
  return sources === undefined || sources.includes(source);
}
