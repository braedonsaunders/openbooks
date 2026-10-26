import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __taxToasts: { kind: string; message: string }[] | undefined;
  var __taxRouter: { push(url: string): void; refresh(): void } | undefined;
}

// TaxFilingsView used to throw bare Error on a !ok compute/save response,
// so the server's named refusal (e.g. the two-registrations choose-one) was
// dropped and the operator read a generic saveFailed. Both paths now surface
// the server's message through readApiErrorMessage. Render-proved: a 422
// with a named error must reach the toast verbatim.

// jsdom first: the view reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/tax", matchMediaMatches: false });
// The view's event interop needs the jsdom Event constructor identity, not
// Node's native global: keep the unconditional pin the inline block had.
(globalThis as Record<string, unknown>).Event = window.Event;

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: "export function useRouter(){return globalThis.__taxRouter}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__taxToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__taxToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { TaxFilingsView } = await import("./TaxFilingsView");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const FORM = {
  code: "CA_GST34",
  name: "GST/HST Return",
  country: "CA",
  submission_channel: "portal_manual",
  government_format: "portal_entry",
  submission_url: null,
  notice_key: null,
  has_official: false,
};
type FilingFormFixture = Omit<typeof FORM, "notice_key"> & { notice_key: string | null };

const CHOOSE_ONE =
  'tax return "CA_GST34" has 2 registrations active in this period — choose one: 123456789 (2026-07-01 to 2026-07-31), 987654321 (2026-07-01 to 2026-07-31)';

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function mount(canSave = true, forms: FilingFormFixture[] = [FORM]) {
  globalThis.__taxToasts = [];
  globalThis.__taxRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-07-15">
          <TaxFilingsView forms={forms} canSave={canSave} canManageSetup={false} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
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

function errorToasts(): string[] {
  return (globalThis.__taxToasts ?? []).filter((t) => t.kind === "error").map((t) => t.message);
}

test("a refused compute toasts the server refusal, not a generic failure", async () => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith("/api/tax/returns/"))
      return Response.json({ error: CHOOSE_ONE }, { status: 422 });
    return null;
  });
  const { unmount } = await mount();
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(errorToasts(), [CHOOSE_ONE]);
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("changing filing forms resets edited dates to the current business month", async () => {
  const restoreFetch = scriptFetch(() => Response.json({ obligations: [] }));
  const nextForm = { ...FORM, code: "GB_VAT100", name: "VAT Return" };
  const { unmount } = await mount(true, [FORM, nextForm]);
  try {
    const from = document.querySelector<HTMLInputElement>("#tax-from")!;
    const to = document.querySelector<HTMLInputElement>("#tax-to")!;
    const setDateValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setDateValue.call(from, "2026-03-04");
    setDateValue.call(to, "2026-03-20");
    await act(async () => {
      from.dispatchEvent(new window.Event("change", { bubbles: true }));
      to.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const form = document.querySelector<HTMLButtonElement>("#tax-form")!;
    await click(form);
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (el) => el.textContent?.trim() === "VAT Return",
    );
    assert.ok(option, "the second return form must be offered");
    await click(option as HTMLButtonElement);
    assert.equal(from.value, "07/01/2026");
    assert.equal(to.value, "07/31/2026");
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a newly declared filing form displays its own submission notice", async () => {
  const newForm = {
    ...FORM,
    code: "XX_FORM_1",
    name: "Exemplia filing",
    notice_key: "submission.gst34Notice",
  };
  const restoreFetch = scriptFetch(() => Response.json({ obligations: [] }));
  const { unmount } = await mount(true, [newForm]);
  try {
    assert.match(document.body.textContent ?? "", /GST34 is normally entered in CRA Account/);
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("without the filing grant no save action renders after a successful compute", async () => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith("/api/tax/returns/")) {
      return Response.json({
        formCode: "CA_GST34",
        formName: "GST/HST Return",
        from: "2026-07-01",
        to: "2026-07-31",
        submissionChannel: "portal_manual",
        watermark: null,
        boxes: [],
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      });
    }
    return null;
  });
  const { unmount } = await mount(false);
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(buttonsNamed("Save to history"), []);
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a refused save toasts the server refusal, not a generic failure", async () => {
  const PREPARE_REFUSAL = "the return changed since it was previewed — recompute before saving";
  let prepareBody: unknown;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/tax/returns/")) {
      return Response.json({
        formCode: "CA_GST34",
        formName: "GST/HST Return",
        from: "2026-07-01",
        to: "2026-07-31",
        submissionChannel: "portal_manual",
        watermark: null,
        boxes: [],
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      });
    }
    if (url === "/api/tax/filings" && init?.method === "POST") {
      prepareBody = JSON.parse(String(init.body));
      return Response.json({ error: PREPARE_REFUSAL }, { status: 422 });
    }
    return null;
  });
  const { unmount } = await mount();
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(errorToasts(), []);
    await click(buttonsNamed("Save to history")[0]!);
    assert.deepEqual(errorToasts(), [PREPARE_REFUSAL]);
    assert.deepEqual(prepareBody, {
      code: "CA_GST34",
      from: "2026-07-01",
      to: "2026-07-31",
      adjustments: [],
    });
  } finally {
    await unmount();
    restoreFetch();
  }
});

async function enterInput(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("a refused adjustment preview removes the old totals and save action until a successful recompute", async () => {
  let refuseAdjusted = true;
  const prepareBodies: unknown[] = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/tax/returns/")) {
      if (url.includes("adj_104=") && refuseAdjusted) {
        return Response.json(
          { error: "The adjustment cannot be included in this return." },
          { status: 422 },
        );
      }
      return Response.json({
        formCode: "CA_GST34",
        formName: "GST/HST Return",
        from: "2026-07-01",
        to: "2026-07-31",
        submissionChannel: "portal_manual",
        watermark: null,
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
        boxes: [
          {
            lineCode: "104",
            label: "Adjustments",
            value: url.includes("adj_104=") ? "3018.8400" : "0.0000",
            computed: false,
            editable: true,
          },
        ],
      });
    }
    if (url === "/api/tax/filings" && init?.method === "POST") {
      prepareBodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: "filing-1", version: 1 }, { status: 201 });
    }
    return null;
  });
  const { unmount } = await mount();
  try {
    await click(buttonsNamed("Compute")[0]!);
    await enterInput("tax-adjustment-amount", "3018.84");
    await enterInput("tax-adjustment-reason", "Pre-conversion activity");
    const form = document.querySelector<HTMLFormElement>("form");
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    await tick();
    assert.deepEqual(errorToasts(), ["The adjustment cannot be included in this return."]);
    assert.equal(buttonsNamed("Save to history").length, 0);
    assert.deepEqual(prepareBodies, []);
    refuseAdjusted = false;
    await click(buttonsNamed("Compute")[0]!);
    assert.match(document.body.textContent ?? "", /3,018\.84/);
    await click(buttonsNamed("Save to history")[0]!);
    assert.deepEqual(prepareBodies, [
      {
        code: "CA_GST34",
        from: "2026-07-01",
        to: "2026-07-31",
        adjustments: [{ lineCode: "104", amount: "3018.84", reason: "Pre-conversion activity" }],
      },
    ]);
  } finally {
    await unmount();
    restoreFetch();
  }
});
