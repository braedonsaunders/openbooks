import { createHash } from "node:crypto";

const FILE = "generated/0699_financial_history_native_clone_guards.sql";
const PUBLISHED = "eb192fe9113093021a6b6998c18fb08f671e9a1a22182e4265bd2132fad67e5a";
const EXPRESSION = "CASE candidate->>'key' WHEN 'spot' THEN 'Spot' WHEN 'average' THEN 'Average' ELSE 'Historical' END";
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

export type MigrationExecutionCorrection = {
  id: string;
  publishedSha256: string;
  executedSha256: string;
};

/** Parentheses distinguish a published SQL CASE from its enclosing PL/pgSQL
 * IF. Preserve the source identity and separately record the executable form. */
export function migrationExecutionCompatibility(filename: string, content: string): {
  content: string;
  correction?: MigrationExecutionCorrection;
} {
  if (filename !== FILE) return { content };
  if (digest(content) !== PUBLISHED) throw new Error(`${filename}: execution compatibility requires the exact published digest`);
  if (content.split(EXPRESSION).length !== 2) throw new Error(`${filename}: execution compatibility requires one exact CASE expression`);
  const corrected = content.replace(EXPRESSION, `(${EXPRESSION})`);
  return {
    content: corrected,
    correction: {
      id: "financial-history-seeded-rate-case-parentheses",
      publishedSha256: PUBLISHED,
      executedSha256: digest(corrected),
    },
  };
}
