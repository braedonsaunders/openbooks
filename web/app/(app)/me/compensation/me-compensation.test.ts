import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the compensation page (/me/compensation). The
// spec builder runs over hand-built data: a refused read renders its
// title and remedy, the linked-but-empty state carries its next step,
// and both content panels gate on the content resolver. Band placement
// and statement reads stay covered by the engine compensation tests,
// which own the service shapes.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { myCompSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(myCompSpec(data as never));
}

const TABS = [{ label: "Compensation", href: "/me/compensation" }];

function baseData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    emptyTitle: "No compensation on file",
    emptyDescription: "Ask HR to place you in a band",
  } as unknown as Record<string, unknown>;
}

test("a refused compensation read renders the remedy", () => {
  const data = baseData();
  data.refusal = { title: "No compensation", message: "ask an administrator for a linked employment" };
  const json = specJson(data);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No compensation"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
});

test("the empty state carries its next step with content gated on its resolver", () => {
  const json = specJson(baseData());
  assert.ok(json.includes("No compensation on file"), "the empty state names the situation");
  assert.ok(json.includes("Ask HR to place you in a band"), "the empty state names the next step");
  assert.ok(json.includes("\"hasContent\""), "the placement panel gates on the content resolver");
  assert.ok(json.includes("\"hrm-placement-summary\""), "the placement widget renders");
  assert.ok(json.includes("\"hrm-pay-info-request\""), "the pay-information request renders as the next step");
});

// The no-link refusal is one remedy shared with the engine: the catalog
// copy a locale renders when the login has no linked person must stay
// word-for-word identical to the SelfServiceError NO_LINK message the
// engine throws, or the two renderings drift.
const LOCALES = ["en", "fr", "es", "de", "ja", "zh", "pt-BR"] as const;
const REFUSAL_KEYS = ["myComp.emptyTitle", "myComp.emptyDescription", "myComp.notLinked"] as const;

function catalogAt(catalog: Record<string, unknown>, path: string): unknown {
  let node: unknown = catalog;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

test("every locale carries the empty and refusal copy translated", () => {
  const en = JSON.parse(readFileSync(new URL("../../../../../web/messages/en/hrm.json", import.meta.url), "utf8")) as Record<string, unknown>;
  for (const locale of LOCALES) {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../../../../web/messages/${locale}/hrm.json`, import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    for (const key of REFUSAL_KEYS) {
      const value = catalogAt(catalog, key);
      assert.equal(typeof value, "string", `${locale} hrm.json lacks "${key}" — /me/compensation renders the key path`);
      assert.ok((value as string).trim().length > 0, `${locale} hrm.json "${key}" is blank — /me/compensation renders nothing`);
      if (locale !== "en") {
        assert.notEqual(value, catalogAt(en, key), `${locale} hrm.json "${key}" copies English — translate it`);
      }
    }
  }
});

test("the English no-link remedy matches the engine refusal word for word", async () => {
  const { actorPartyOf, SelfServiceError } = await import("../../../../../engine/src/hrm/self-service/actor.ts");
  type Executor = Pick<import("../../../../../engine/src/platform/db.ts").SqlExecutor, "execute">;
  const exec = {
    execute: async () => ({ rows: [] as { partyId: string | null }[] }),
  } as unknown as Executor;
  const thrown: unknown = await actorPartyOf(exec, "org-1", "user-1").then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(thrown instanceof SelfServiceError, "an unlinked login must throw SelfServiceError");
  assert.equal((thrown as { code: string }).code, "NO_LINK", "the refusal carries the NO_LINK code");
  const en = JSON.parse(readFileSync(new URL("../../../../../web/messages/en/hrm.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.equal(
    catalogAt(en, "myComp.notLinked"),
    (thrown as Error).message,
    "en myComp.notLinked drifted from the engine NO_LINK remedy — one remedy, keep them identical",
  );
});
