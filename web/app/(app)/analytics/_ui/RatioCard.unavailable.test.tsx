import assert from "node:assert/strict";
import test from "node:test";

// F4-9: an unavailable ratio card with no loader note rendered the hardcoded
// English "Data not available" in every locale. The card now falls back to
// the translated analytics.financialHealth.ratioNotes.unavailable string,
// while a loader-supplied noDataMsg (already localized via ratioNotes) still
// wins. (The prop is populated by the financial-health loader — only the
// fallback was English.)

// jsdom first: the card reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/analytics",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/fr")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { RatioCard } = await import("./RatioCard");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const DEF = {
  label: "Marge brute",
  formula: "MB / CA",
  desc: "sens",
  interpret: "lecture",
};

async function renderCard(noDataMsg?: string) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <RatioCard
            data={{
              id: "gross_margin",
              value: null,
              format: "pct",
              benchmark: 0.4,
              calc: "N/A",
              noData: true,
              ...(noDataMsg === undefined ? {} : { noDataMsg }),
              grade: null,
            }}
            def={DEF}
          />
        </MoneyProvider>
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

test("an unavailable ratio without a loader note renders the French fallback", async (t) => {
  const { unmount } = await renderCard();
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Données non disponibles/, "the fallback must be translated");
  assert.ok(!/Data not available/.test(text), "no English fallback may leak into the French card");
});

test("a loader-supplied note still wins over the translated fallback", async (t) => {
  const { unmount } = await renderCard("Aucune donnée de bilan");
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Aucune donnée de bilan/, "the loader note must render verbatim");
  assert.ok(!/Données non disponibles/.test(text), "the fallback must not override the loader note");
});
