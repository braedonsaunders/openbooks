import { parseExactJson } from "@openbooks/engine/platform/exact-json";

/** Preserve the import boundary's exact numeric text and last-key-wins contract. */
export function parseImportJson(text: string): unknown {
  return parseExactJson(text);
}
