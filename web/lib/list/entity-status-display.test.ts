import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t12-017/018 residuals: the opportunity LIST cell (and the status
// quick-filter picker) rendered the raw DB-seeded English status name
// ("Closed lost") in fr/es — the drawer pill path was fixed, but the
// universal entity list uses a different label path (s.name straight into
// the badge). The opportunity source now carries a statusDisplayName hook:
// unrenamed seeds render through crm.opportunities.statuses, tenant
// renames keep their stored names, and locales without the subtree keep
// the stored name instead of a raw message key.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

const { entityListSource } = await import("./entity-sources.ts");

const catalog = (locale: string): Record<string, string> => {
  const raw = readFileSync(new URL(`../../messages/${locale}/crm.json`, import.meta.url), "utf8");
  return (JSON.parse(raw) as { opportunities: { statuses: Record<string, string> } }).opportunities.statuses;
};
const lookup = (locale: string) => {
  const statuses = catalog(locale);
  return (fullKey: string): string => {
    const key = fullKey.replace("crm.opportunities.statuses.", "");
    const hit = statuses[key];
    if (hit === undefined) throw new Error(`missing: ${fullKey}`);
    return hit;
  };
};

test("F-t12-017/018: opportunity list statuses translate seeded names", () => {
  const source = entityListSource("opportunity");
  assert.ok(source, "opportunity source is registered");
  assert.equal(source.statusFilterKey, "status_id", "status picker filter is identified");
  assert.equal(typeof source.statusDisplayName, "function", "source carries a status display hook");
  const display = source.statusDisplayName!;
  assert.equal(display("Closed lost", lookup("fr")), catalog("fr")["closedLost"], "fr seed renders through the catalog");
  assert.equal(display("Closed lost", lookup("es")), catalog("es")["closedLost"], "es seed renders through the catalog");
  assert.equal(display("Closed lost", lookup("en")), catalog("en")["closedLost"], "en seed renders through the catalog");
  assert.equal(display("My Custom Pipe", lookup("fr")), "My Custom Pipe", "tenant renames keep their stored name");
  assert.equal(
    display("Closed lost", (fullKey) => fullKey),
    "Closed lost",
    "locales without the subtree keep the stored name, never a raw key",
  );
});
