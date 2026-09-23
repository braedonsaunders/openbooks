import assert from "node:assert/strict";
import test from "node:test";

// The drawer is the only place in the app that files an exception, and since
// requests file as pending, it must also be the place that approves them: a
// pending row carries a Pending approval badge, a waive-holder who did not
// request it gets an Approve action, the requester does not, and a refused
// approval pins the server's message to its row.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/compliance/vendors",
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
if (typeof domWindow.requestAnimationFrame !== "function") {
  domWindow.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  domWindow.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = domWindow.requestAnimationFrame;
  globals.cancelAnimationFrame = domWindow.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/compliance/vendors'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const messages = (await import("../../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { VendorComplianceDrawer } = await import("./VendorComplianceDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
// The tab panels animate through AnimatePresence on switch; jsdom needs a
// beat longer than a tick for the exiting panel to leave and the entering
// one to mount.
const settleTabs = () => new Promise((resolve) => setTimeout(resolve, 800));

const REQUESTER = "00000000-0000-4000-8000-000000000011";
const APPROVER = "00000000-0000-4000-8000-000000000022";
const EXCEPTION_ID = "00000000-0000-4000-8000-000000000033";

function pendingException() {
  return {
    id: EXCEPTION_ID,
    requirementCode: "COI",
    requirementName: "Certificate of insurance",
    projectName: null,
    reason: "Carrier renewal delayed by underwriter backlog",
    effectiveFrom: "2026-06-01",
    expiresOn: "2026-08-01",
    status: "pending_approval" as const,
    requestedById: REQUESTER,
    approvedByName: null,
    approvedAt: null,
  };
}

function drawerData() {
  return {
    vendor: {
      id: "00000000-0000-4000-8000-000000000044",
      name: "Waiver vendor",
      legalName: null,
      complianceClassId: null,
      informationReturnForm: null,
      informationReturnBox: null,
      taxClassification: null,
      tinLast4: null,
      tinType: null,
      backupWithholding: false,
      reportable: false,
    },
    certificates: [],
    exceptions: [pendingException()],
    policies: [],
    classes: [],
    projects: [],
    status: null,
  };
}

const patchCalls: { url: string; body: unknown }[] = [];

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountExceptions(currentUserId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-07-01">
          <VendorComplianceDrawer
            data={drawerData() as never}
            closeHref="/compliance/vendors"
            formTypes={[]}
            canManage={false}
            canVerify={false}
            canWaive={true}
            currentUserId={currentUserId}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  const exceptionsTab = [...document.querySelectorAll('button[role="tab"]')].find((b) =>
    b.textContent?.startsWith("Exceptions"),
  ) as HTMLButtonElement | undefined;
  assert.ok(exceptionsTab, "the exceptions tab renders");
  await act(async () => {
    exceptionsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settleTabs();
  });
  await settleTabs();
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
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
  await settleTabs();
}

test("a pending exception shows Approve to a second user but not to the requester", async () => {
  const restoreFetch = scriptFetch(() => null);
  try {
    const requester = await mountExceptions(REQUESTER);
    try {
      assert.ok(
        document.body.textContent?.includes("Pending approval"),
        "the requester sees the pending badge",
      );
      assert.deepEqual(buttonsNamed("Approve"), [], "the requester gets no Approve action");
    } finally {
      await requester.unmount();
    }
    const approver = await mountExceptions(APPROVER);
    try {
      assert.ok(
        document.body.textContent?.includes("Pending approval"),
        "the approver sees the pending badge",
      );
      assert.equal(buttonsNamed("Approve").length, 1, "a second user gets the Approve action");
    } finally {
      await approver.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("approving sends the approve transition for that exception", async () => {
  patchCalls.length = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/compliance/waivers/${EXCEPTION_ID}` && init?.method === "PATCH") {
      patchCalls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: EXCEPTION_ID, status: "approved" });
    }
    return null;
  });
  try {
    const view = await mountExceptions(APPROVER);
    try {
      await click(buttonsNamed("Approve")[0]!);
      assert.equal(patchCalls.length, 1, "one approve transition is sent");
      assert.deepEqual(patchCalls[0]!.body, { action: "approve" });
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("a refused approval pins the server message to its row", async () => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/compliance/waivers/${EXCEPTION_ID}` && init?.method === "PATCH") {
      return Response.json({ error: "not found or already decided" }, { status: 404 });
    }
    return null;
  });
  try {
    const view = await mountExceptions(APPROVER);
    try {
      await click(buttonsNamed("Approve")[0]!);
      assert.ok(
        document.body.textContent?.includes("not found or already decided"),
        "the refusal is pinned to the row",
      );
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});
