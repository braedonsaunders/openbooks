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

/** Apply exact reviewed corrections while retaining the immutable source
 * identity and separately recording the executable form. */
export function migrationExecutionCompatibility(filename: string, content: string): {
  content: string;
  correction?: MigrationExecutionCorrection;
} {
  if (filename === "baselines/alpha29.sql") {
    const published = "4b29a81bdc359b46b467634ae6d800f9ae9c33b8f17e7efa4b0696218428456c";
    if (digest(content) !== published) throw new Error(`${filename}: execution compatibility requires the exact published digest`);
    // Host administrators own installed extensions. Their descriptive comments
    // are not application schema and require ownership the migration role lacks.
    const comments = [
      "COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';",
      "COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';",
    ];
    let executable = content;
    for (const comment of comments) {
      if (executable.split(comment).length !== 2) throw new Error(`${filename}: execution correction requires one exact extension comment`);
      executable = executable.replace(comment, "");
    }
    return { content: executable, correction: {
      id: "host-owned-extension-metadata", publishedSha256: published, executedSha256: digest(executable),
    } };
  }
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
