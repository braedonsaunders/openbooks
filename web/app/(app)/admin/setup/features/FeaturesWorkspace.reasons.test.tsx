import assert from "node:assert/strict";
import test from "node:test";

// The switchboard's "Requires X." and "Works best with Y." reason
// lines were inline English template literals around catalog titles, so a
// non-English locale read English reasons between translated rows. Both now
// resolve through setup.features.requiresNote / recommendsNote.

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/setup/features", matchMediaMatches: false });

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/admin/setup/features" } });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }

    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(){return null}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { createTranslator } = await import("next-intl");
const { LOCALE_CODES } = await import("../../../../../i18n/config");
const { FEATURE_CATEGORIES, FEATURE_GROUPS } = await import("@openbooks/engine/organization/feature-catalog");
const messages = (await import("../../../../../messages/fr")).default;
const { FeaturesWorkspace } = await import("./FeaturesWorkspace");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderWorkspace() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC" onError={(error) => { throw error; }}>
        <FeaturesWorkspace
          features={[
            { key: "bankFeeds", category: "finance", enabled: true, requiresAll: ["banking"] },
            { key: "banking", category: "finance", enabled: false },
            { key: "fixedAssets", category: "finance", enabled: true, recommends: ["multiCurrency"] },
            { key: "multiCurrency", category: "finance", enabled: false },
            { key: "queryConsole", category: "platform", enabled: false },
          ]}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("requires and recommends reasons render translated with catalog titles", async (t) => {
  const { unmount } = await renderWorkspace();
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Requiert Banque\./, "the missing requirement must read French with the catalog title");
  assert.match(
    text,
    /Fonctionne mieux avec Multidevise\./,
    "the missing recommendation must read French with the catalog title",
  );
  assert.ok(!/Requires /.test(text), "no English Requires template may leak into the French page");
  assert.ok(!/Works best with /.test(text), "no English Works best with template may leak into the French page");
  assert.match(text, /Autres fonctionnalités/, "ungrouped features have a translated fallback heading");
});

test("all shipped locales resolve feature areas and group headings without missing messages", async () => {
  const groupKeys = new Set([...Object.values(FEATURE_GROUPS).flat(), "other"]);
  for (const locale of LOCALE_CODES) {
    const catalog = (await import(`../../../../../messages/${locale}/index.ts`)).default;
    const t = createTranslator({ locale, messages: catalog, namespace: "admin", onError: (error) => { throw error; } });
    for (const category of FEATURE_CATEGORIES) {
      assert.ok(t(`setup.features.categories.${category}`).trim(), `${locale}: ${category}`);
    }
    for (const group of groupKeys) {
      assert.ok(t(`setup.features.groups.${group}`).trim(), `${locale}: ${group}`);
    }
  }
});

test("search finds a feature on another tab, accent-insensitively, and clearing restores the tab", async (t) => {
  const { unmount } = await renderWorkspace();
  t.after(unmount);
  const title = "Console de requêtes";
  const rendered = () => [...document.querySelectorAll('[role="switch"]')].map((sw) => sw.getAttribute("aria-label"));
  assert.ok(!rendered().includes(title), "a Platform feature stays off the Finance tab");
  const input = document.querySelector('input[type="search"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
  };
  await type("requetes");
  assert.deepEqual(rendered(), [title], "only the match renders, from whichever tab owns it");
  assert.deepEqual(
    [...document.querySelectorAll("h3")].map((h) => h.textContent),
    ["Plateforme"],
    "matches are grouped under their tab name",
  );
  await type("introuvable");
  assert.match(document.body.textContent ?? "", /introuvable/, "an empty search names the query it could not match");
  await type("");
  assert.ok(rendered().includes("Banque") && !rendered().includes(title), "a cleared search returns to the active tab");
});
