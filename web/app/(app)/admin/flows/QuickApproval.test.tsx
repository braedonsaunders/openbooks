const pushed: string[] = [];
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){ return { refresh(){}, push(url){ globalThis.__quickPushes.push(url) } } }" +
    '; export function useSearchParams(){ return new URLSearchParams(globalThis.__quickSearch ?? "") }',
});
Object.assign(globalThis, { __quickPushes: pushed, __quickSearch: "?quickApproval=vendor_bill" });
import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/flows", scrollIntoView: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { QuickApprovalButton } = await import("./QuickApproval");

/**
 * One-step approval setup dialog: four clicks (subject → threshold →
 * approver → create) produce a complete enabled flow through POST
 * /api/admin/flows/quick-approval, and an existing setup offers removal
 * (audited disable, never delete). The deep link (?quickApproval=kind)
 * preselects the subject so record-kind settings land here directly.
 */

type FetchCall = { url: string; init: RequestInit };

const PROFILES = { profiles: [{ subjectKind: "vendor_bill", label: "Vendor bill" }] };
const FRESH_STATE = {
  flow: null,
  users: [{ id: "u-1", name: "Ada", email: "ada@scratch.test" }],
  roles: [
    { key: "admin", name: "Admins" },
    { key: "accountant", name: "Accountants" },
  ],
  amountField: "total",
  subjectLabel: "Vendor bill",
};

function stubFetch(routes: Record<string, { status?: number; body: unknown }>): FetchCall[] {
  const calls: FetchCall[] = [];
  Object.assign(globalThis, {
    fetch: async (url: unknown, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      const key = Object.keys(routes).find((k) => call.url.includes(k));
      const route = (key ? routes[key] : undefined) ?? { status: 404, body: {} };
      return {
        ok: (route.status ?? 200) < 300,
        status: route.status ?? 200,
        json: async () => route.body,
      };
    },
  });
  return calls;
}

function renderButton(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QuickApprovalButton />
      </NextIntlClientProvider>,
    );
  });
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(root: ParentNode, text: string): HTMLElement {
  const found = [...(root as Document).querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  assert.ok(found, `expected a button reading "${text}"`);
  return found as HTMLElement;
}

// The drawer portals into document.body, outside the render host.
function dialogText(): string {
  return document.body.textContent ?? "";
}

test("the dialog opens preselected and creates with the admin default", async () => {
  pushed.length = 0;
  const calls = stubFetch({
    "/api/admin/flows/profiles": { body: PROFILES },
    "quick-approval?subjectKind": { body: FRESH_STATE },
    "/api/admin/flows/quick-approval": { body: { id: "flow-new" } },
  });
  const host = renderButton();
  try {
    await flush();
    await flush();
    // Deep link opened the dialog with the subject preselected.
    assert.match(dialogText(), /Require approval/);
    // The approver defaults to the org's admins — one role, never blank.
    const selects = [...document.querySelectorAll("select")];
    const roleSelect = selects.find((s) =>
      [...s.querySelectorAll("option")].some((o) => o.textContent?.includes("Admins")),
    );
    assert.ok(roleSelect, "expected the role approver picker");
    assert.equal((roleSelect as HTMLSelectElement).value, "admin");
    // Self-approval prevention defaults on.
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    assert.ok(box, "expected the self-approval checkbox");
    assert.equal(box.checked, true);

    act(() => {
      buttonByText(document, "Create approval flow").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    const post = calls.find(
      (c) => c.url.endsWith("/api/admin/flows/quick-approval") && c.init.method === "POST",
    );
    assert.ok(post, "expected the quick-approval POST");
    const body = JSON.parse(String(post?.init.body));
    assert.deepEqual(body, {
      subjectKind: "vendor_bill",
      approver: { type: "role", role: "admin" },
      preventSelfApproval: true,
    });
    assert.deepEqual(pushed, ["/admin/flows/flow-new"], "creation lands on the wired flow");
  } finally {
    host.remove();
  }
});

test("an existing setup offers removal through the audited disable path", async () => {
  pushed.length = 0;
  const calls = stubFetch({
    "/api/admin/flows/profiles": { body: PROFILES },
    "quick-approval?subjectKind": {
      body: {
        ...FRESH_STATE,
        flow: { id: "flow-1", name: "Approval: Vendor bill", enabled: true, updatedAt: "rev-9" },
      },
    },
    "/api/admin/flows/flow-1": { body: { ok: true, updatedAt: "rev-10", enabled: false } },
  });
  const host = renderButton();
  try {
    await flush();
    await flush();
    assert.match(dialogText(), /already gated by this flow/);
    act(() => {
      buttonByText(document, "Remove approval").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    const patch = calls.find((c) => c.url.endsWith("/api/admin/flows/flow-1"));
    assert.ok(patch, "expected the disable PATCH on the setup flow");
    assert.equal(patch?.init.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patch?.init.body)), {
      enabled: false,
      expectedUpdatedAt: "rev-9",
    });
    assert.deepEqual(pushed, [], "removal stays on the list — nothing is deleted");
  } finally {
    host.remove();
  }
});

test("a coded refusal never navigates away", async () => {
  pushed.length = 0;
  stubFetch({
    "/api/admin/flows/profiles": { body: PROFILES },
    "quick-approval?subjectKind": { body: FRESH_STATE },
    "/api/admin/flows/quick-approval": {
      status: 400,
      body: { error: "That role is not available.", code: "unknown-role" },
    },
  });
  const host = renderButton();
  try {
    await flush();
    await flush();
    act(() => {
      buttonByText(document, "Create approval flow").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    assert.deepEqual(pushed, [], "a refused setup stays in the dialog");
  } finally {
    host.remove();
  }
});
