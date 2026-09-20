import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t11-012 follow-up: an OLD stored finding carries summary.href
// "/ar/cockpit" (and a citation with the same dead href). The read model
// must resolve both through the registry — the drawer renders what it is
// given, so the fix belongs here, shared by every consumer.
const OLD_FINDING = {
  id: "work-item-old",
  agent_key: "collections",
  finding_type: "overdue",
  severity: "high",
  status: "open",
  confidence: "0.9",
  materiality: "100.00",
  summary: {
    href: "/ar/cockpit",
    aiAnalysis: {
      headline: "Old finding",
      citations: [
        { href: "/ar/cockpit", label: "AR cockpit" },
        { href: "/ar/invoices/inv-1", label: "Invoice" },
      ],
    },
  },
  first_detected_at: "2026-09-01T00:00:00.000Z",
  last_detected_at: "2026-09-16T00:00:00.000Z",
  dismissal_reason: null,
  rating: null,
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", format: "module", shortCircuit: true };
    }
    if (specifier === "drizzle-orm") {
      return { url: "mock:work-item-drizzle", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/platform/db.ts") {
      return { url: "mock:work-item-db", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/navigation/nav-registry.ts") {
      // The worktree's root node_modules is a symlink to the main
      // checkout's modules, so the workspace alias would resolve the
      // registry to the main checkout (stale). Pin it to this checkout's
      // file: in a normal checkout this maps to the identical module.
      return {
        url: new URL("../../../engine/src/navigation/nav-registry.ts", import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:work-item-drizzle") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export function sql(strings, ...values) { return { strings: Array.from(strings), values }; }
          sql.raw = (value) => ({ raw: String(value) });
        `,
      };
    }
    if (url === "mock:work-item-db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const finding = ${JSON.stringify(OLD_FINDING)};
          function statementText(query) {
            if (!Array.isArray(query?.strings)) return String(query);
            return query.strings.map((part, index) =>
              part + (index < (query.values?.length ?? 0) ? String(query.values[index]) : "")).join("");
          }
          export const db = {
            async execute(query) {
              const text = statementText(query);
              if (/ai_work_item_evidence/i.test(text)) return { rows: [] };
              return { rows: [{ ...finding }] };
            },
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { loadWorkItemDetail } = await import("./work-item.ts");
hooks.deregister();

test("old stored finding hrefs resolve through the registry at load", async () => {
  const item = await loadWorkItemDetail("org-1", "user-1", "work-item-old", ["collections"]);
  assert.ok(item, "old finding must load");
  const summary = item.summary as Record<string, unknown>;
  assert.equal(summary.href, "/ar", "stored /ar/cockpit must resolve to the live ar href");
  const citations = (summary.aiAnalysis as { citations: { href: string; label: string }[] }).citations;
  assert.equal(citations[0]!.href, "/ar", "stored citation href must resolve too");
  assert.equal(citations[1]!.href, "/ar/invoices/inv-1", "live deep-link citations must pass through");
});
