import assert from "node:assert/strict";
import test from "node:test";

// Exception decisions use the tenant Flow's record state and gate endpoint.
// The drawer must never infer approval authority from the waiver permission
// or from whether the viewer is the requester.

// jsdom first: the drawer reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/compliance/vendors",
  matchMediaMatches: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/compliance/vendors" } });
registerHooks({
  resolve(specifier, context, next) {
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
const GATE_ID = "00000000-0000-4000-8000-000000000022";
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

const decisionCalls: { url: string; body: unknown }[] = [];

function approvalState(canDecide: boolean) {
  return {
    approvalState: {
      status: "pending_approval",
      pendingWith: [
        { name: "Assigned reviewer", gateId: GATE_ID, since: "2026-07-01T12:00:00.000Z" },
      ],
      myActions: canDecide ? { gateId: GATE_ID, signatureRequired: false } : null,
    },
    history: [],
    failedRun: null,
    neverSubmitted: false,
    canRetry: false,
    submittedByViewer: false,
  };
}

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

async function mountExceptions() {
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
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  const exceptionsTab = [...document.querySelectorAll("button[aria-pressed]")].find((b) =>
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

test("a waiver permission alone cannot approve an exception without an assigned Flow gate", async () => {
  const restoreFetch = scriptFetch((url) =>
    url.startsWith("/api/flows/record-state?") ? Response.json(approvalState(false)) : null,
  );
  try {
    const view = await mountExceptions();
    try {
      assert.ok(document.body.textContent?.includes("Pending approval"));
      assert.deepEqual(buttonsNamed("Approve"), []);
      assert.ok(document.body.textContent?.includes("Assigned reviewer"));
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("an assigned exception reviewer decides the exact Flow gate", async () => {
  decisionCalls.length = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/flows/record-state?")) return Response.json(approvalState(true));
    if (init?.method && init.method !== "GET") {
      decisionCalls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ resumed: null });
    }
    return null;
  });
  try {
    const view = await mountExceptions();
    try {
      assert.equal(buttonsNamed("Approve").length, 1);
      await click(buttonsNamed("Approve")[0]!);
      assert.deepEqual(decisionCalls, [
        {
          url: "/api/flows/gates/decide",
          body: { gateId: GATE_ID, decision: "approved" },
        },
      ]);
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("a refused Flow decision keeps its actionable message beside the exception", async () => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/flows/record-state?")) return Response.json(approvalState(true));
    if (url === "/api/flows/gates/decide" && init?.method === "POST") {
      return Response.json(
        { error: "This gate was already decided; refresh the exception." },
        { status: 409 },
      );
    }
    return null;
  });
  try {
    const view = await mountExceptions();
    try {
      await click(buttonsNamed("Approve")[0]!);
      assert.ok(
        document
          .querySelector("[role=dialog]")
          ?.textContent?.includes("This gate was already decided; refresh the exception."),
      );
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("an unsubmitted pending exception uses the native Flow submission control", async () => {
  decisionCalls.length = 0;
  const state = approvalState(false);
  state.approvalState.pendingWith = [];
  state.neverSubmitted = true;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/flows/record-state?")) return Response.json(state);
    if (init?.method && init.method !== "GET") {
      decisionCalls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: EXCEPTION_ID, status: "approved" });
    }
    return null;
  });
  try {
    const view = await mountExceptions();
    try {
      assert.equal(buttonsNamed("Approve").length, 0);
      const submit = buttonsNamed(messages.common.approvalFlow.submitRun)[0];
      assert.ok(submit, "the shared native submission action is available");
      await click(submit);
      assert.deepEqual(decisionCalls, [
        {
          url: `/api/compliance/waivers/${EXCEPTION_ID}`,
          body: { action: "approve" },
        },
      ]);
    } finally {
      await view.unmount();
    }
  } finally {
    restoreFetch();
  }
});
