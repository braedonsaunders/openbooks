import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/sign/quotes/test-token",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return { refresh(){} }}export function usePathname(){return '/sign/quotes/test-token'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default as Record<string, unknown>;
const { QuoteSignForm } = await import("./QuoteSignForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function fullView() {
  return {
    quoteNumber: "Q-9",
    status: "sent",
    currency: "USD",
    total: "1200.0000",
    documentDate: "2026-10-01",
    terms: [
      {
        planName: "Quoted plan",
        termMonths: 12,
        startRule: "quote_date",
        billingTiming: "advance",
        periods: [{ unitPrice: "100.00", quantity: "1", periodAmount: "1200.0000" }],
        tcv: "1200.0000",
      },
    ],
    tcv: "1200.0000",
    signature: {
      status: "sent",
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
      expiresAt: "2026-10-19T15:30:57.884Z",
      consentText: "By typing my name below I accept this order as the customer's authorized signatory.",
    },
  };
}

async function mountForm(
  getImpl: () => Promise<Response>,
  postImpl?: (init?: RequestInit) => Promise<Response>,
) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return postImpl ? postImpl(init) : Response.json({});
    return getImpl();
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QuoteSignForm token="test-token" />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return {
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = priorFetch;
    },
  };
}

/**
 * A link whose signing request is gone must refuse with the re-send remedy
 * instead of throwing on the missing signature — the form previously read
 * body.signature.signerName unguarded and crashed the whole card.
 */
test("a view without an open signature refuses with the re-send remedy", async (t) => {
  const view = fullView();
  (view as { signature: unknown }).signature = null;
  const mounted = await mountForm(async () => Response.json(view));
  t.after(() => mounted.cleanup());

  assert.match(
    document.body.textContent ?? "",
    /no active signing request/,
    "the form must name the missing request instead of crashing",
  );
  assert.match(
    document.body.textContent ?? "",
    /re-send the signing link/,
    "the refusal must name the working remedy",
  );
});

/** Terminal request states render their own cards — never the signing form. */
test("voided and signed requests explain themselves without a form", async (t) => {
  const voided = fullView();
  (voided.signature as { status: string }).status = "voided";
  const first = await mountForm(async () => Response.json(voided));
  assert.match(
    document.body.textContent ?? "",
    /no longer open/,
    "a voided link must name its state with the re-send remedy",
  );
  assert.equal(
    document.querySelector("input:not([type=checkbox])"),
    null,
    "no signing form may render for a voided link",
  );
  await first.cleanup();

  const signed = fullView();
  (signed.signature as { status: string }).status = "signed";
  const second = await mountForm(async () => Response.json(signed));
  t.after(() => second.cleanup());
  assert.match(
    document.body.textContent ?? "",
    /already recorded a signature/,
    "a signed link must say the signature is recorded",
  );
});

/** The happy view renders the quoted terms, prefills the signer, and signs. */
test("a full signing view renders terms and records the signature", async (t) => {
  const mounted = await mountForm(
    async () => Response.json(fullView()),
    async () => Response.json({}),
  );
  t.after(() => mounted.cleanup());

  assert.match(document.body.textContent ?? "", /Quoted plan/, "the quoted term must render");
  const name = document.querySelector("input:not([type=checkbox])") as HTMLInputElement;
  assert.ok(name, "the form must ask for the typed name");
  assert.equal(name.value, "Ada Customer", "the signer name prefills from the request");
  const box = document.querySelector("input[type=checkbox]") as HTMLInputElement;
  assert.ok(box, "the form must ask for consent");
  await act(async () => {
    box.click();
    await tick();
  });
  const sign = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Sign this quote"),
  ) as HTMLButtonElement;
  assert.ok(sign && !sign.disabled, "consent must enable signing");
  await act(async () => {
    sign.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  assert.match(
    document.body.textContent ?? "",
    /Signed/,
    "the thank-you confirmation must render after signing",
  );
});
