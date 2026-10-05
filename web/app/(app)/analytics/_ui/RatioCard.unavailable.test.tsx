import assert from "node:assert/strict";
import test from "node:test";

// A ratio card renders the engine's exact value in the reader's locale, and an
// unavailable ratio shows the engine's translated reason — never a zero, never
// English in a French card.

// jsdom first: the card reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/analytics", matchMediaMatches: false, resizeObserver: false });

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

import type { RatioResult } from "../../../../lib/analytics/financial-health";

const RATIO: RatioResult = {
  id: "gross_margin",
  category: "profitability",
  value: "0.2534",
  format: "pct",
  benchmark: "0.4000",
  inverse: false,
  calc: "253 400 $ / 1 000 000 $",
  basis: null,
  unavailable: null,
  score: 63,
  grade: "D",
};

async function renderCard(data: RatioResult) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <RatioCard data={data} def={DEF} />
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

test("an unavailable ratio shows the engine's reason in the reader's language", async (t) => {
  const { unmount } = await renderCard({ ...RATIO, value: null, score: null, grade: null, unavailable: "Aucun chiffre d’affaires sur la période" });
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Aucun chiffre d’affaires sur la période/, "the reason must render");
  assert.match(text, /N\/D/, "the value reads as not available");
  assert.ok(!/0[,.]0 ?%/.test(text), "an unavailable ratio never renders as zero");
});

test("a value renders exactly in the reader's locale against its target", async (t) => {
  const { unmount } = await renderCard(RATIO);
  t.after(unmount);
  const text = (document.body.textContent ?? "").replace(/\u202f|\u00a0/g, " ");
  assert.match(text, /25,3 %/, "0.2534 renders as a French percentage");
  assert.match(text, /40 %/, "the target renders in the same unit");
});

test("a ratio without a target shows ungraded rather than a grade", async (t) => {
  const { unmount } = await renderCard({ ...RATIO, benchmark: null, score: null, grade: null });
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Sans objectif/, "the ungraded state is named");
});
