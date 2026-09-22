import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/index.ts",
  // Deliberately NOT ./migrations/generated: that directory is the
  // hand-curated, digest-tracked publication surface, and nothing here
  // invokes drizzle-kit today. Pointing its generator output there meant one
  // stray `drizzle-kit generate` would publish a 0000_*.sql sorting BEFORE
  // the canonical baseline and abort every fresh bootstrap. If generation is
  // ever needed, review the emitted SQL and move it into a numbered file by
  // hand like every other migration.
  out: "./migrations/drizzle-review",
});
