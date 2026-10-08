/**
 * Run modes beyond migrate, preflight and mirror that only some sources
 * implement. The run command and its callers ask this instead of naming a
 * source, so the capability has one declaration.
 */
const SOURCE_ONLY_RUN_MODES: Record<string, readonly string[]> = {
  project_financials: ["netsuite"],
  attachments: ["netsuite"],
};

export function sourceSupportsRunMode(source: string, mode: string): boolean {
  const sources = SOURCE_ONLY_RUN_MODES[mode];
  return sources === undefined || sources.includes(source);
}
