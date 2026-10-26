import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __withdrawToasts: { kind: string; message: string }[] | undefined;
  var __withdrawPrompt: string | null | undefined;
  var __withdrawRouter: { push(): void; refresh(): void } | undefined;
}

// A pending-approval document shows its submitter a "Withdraw submission"
// recall beside the pending chip; the click collects the mandatory reason,
// posts the native withdraw, and toasts. The button renders only where the
// shared document action rule offers it: a viewer who neither submitted nor
// holds the approve grant, a document that is no longer pending, and surfaces
// without a withdraw surface never see it.
const script = {
  posts: [] as Array<{ url: string; body: unknown }>,
  submittedByViewer: true,
  withdraw: undefined as
    undefined | { documentId: string; status: string; canCreate: boolean; canApprove: boolean },
};
Object.assign(globalThis, {
  __withdrawToasts: [],
  __withdrawRouter: { push() {}, refresh() {} },
});
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills" });

stubModules({
  navigation: { source: "export function useRouter(){return globalThis.__withdrawRouter}" },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__withdrawToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__withdrawToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__withdrawToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__withdrawPrompt ?? null}",
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
const messages = (await import("../messages/en")).default;
const { ApprovalActions } = await import("./approval-actions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(
  options: { noLiveGate?: boolean; failure?: { status: number; body: string } } = {},
) {
  globalThis.__withdrawToasts = [];
  script.posts.length = 0;
  const priorFetch = globalThis.fetch;
  let withdrawn = false;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const href = String(url);
    if (href.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: {
          status: withdrawn ? "draft" : "pending_approval",
          pendingWith:
            withdrawn || options.noLiveGate
              ? []
              : [{ name: "Alicia Approver", gateId: "gate-1", since: "2026-10-01T00:00:00.000Z" }],
          myActions: null,
        },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: false,
        submittedByViewer: script.submittedByViewer,
      });
    }
    if (href === "/api/documents/actions" && (init?.method ?? "GET") === "POST") {
      script.posts.push({ url: href, body: JSON.parse(String(init?.body)) });
      if (options.failure)
        return new Response(options.failure.body, { status: options.failure.status });
      withdrawn = true;
      return Response.json({ id: "doc-1", status: "draft", withdrawn: true });
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${href}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalActions subjectKind="vendor_bill" subjectId="doc-1" withdraw={script.withdraw} />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return { host, root, priorFetch };
}

function withdrawButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find((b) =>
    /withdraw submission/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
}

const pendingSubmission = {
  documentId: "doc-1",
  status: "pending_approval",
  canCreate: true,
  canApprove: false,
};

test("the submitter sees Withdraw submission and it posts the prompted reason", async (t) => {
  script.submittedByViewer = true;
  script.withdraw = pendingSubmission;
  globalThis.__withdrawPrompt = "billed the wrong vendor";
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  const button = withdrawButton(host);
  assert.ok(button, "the submitter must see a Withdraw submission button");
  await act(async () => {
    button.click();
    await tick();
    await tick();
  });
  assert.deepEqual(script.posts, [
    {
      url: "/api/documents/actions",
      body: { action: "withdraw", documentId: "doc-1", reason: "billed the wrong vendor" },
    },
  ]);
  assert.ok(
    (globalThis.__withdrawToasts ?? []).some((toast) => toast.kind === "success"),
    `the withdraw must toast success, got ${JSON.stringify(globalThis.__withdrawToasts)}`,
  );
  assert.equal(
    withdrawButton(host),
    undefined,
    "the refreshed draft must hide withdrawal before its drawer props refresh",
  );
});

test("an approver who did not submit may withdraw through the approve grant", async (t) => {
  script.submittedByViewer = false;
  script.withdraw = { ...pendingSubmission, canCreate: false, canApprove: true };
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  assert.ok(
    withdrawButton(host),
    "an approver must see Withdraw submission for a colleague submission",
  );
});

test("no Withdraw submission for a viewer who neither submitted nor holds the approve grant", async (t) => {
  script.submittedByViewer = false;
  script.withdraw = { ...pendingSubmission, canCreate: true, canApprove: false };
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  assert.equal(
    withdrawButton(host),
    undefined,
    "a create-only colleague must never see a button the engine would refuse",
  );
});

test("no Withdraw submission once the document is no longer pending approval", async (t) => {
  script.submittedByViewer = true;
  script.withdraw = { ...pendingSubmission, status: "approved" };
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  assert.equal(withdrawButton(host), undefined, "a decided submission must not offer a recall");
});

test("no Withdraw submission without a withdraw surface", async (t) => {
  script.submittedByViewer = true;
  script.withdraw = undefined;
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  assert.equal(
    withdrawButton(host),
    undefined,
    "surfaces without a document withdraw path must stay quiet",
  );
});

test("a pending submitter may recall even when no live approval gate remains", async (t) => {
  script.submittedByViewer = true;
  script.withdraw = pendingSubmission;
  const { host, root, priorFetch } = await mount({ noLiveGate: true });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = priorFetch;
  });
  assert.ok(
    withdrawButton(host),
    "the document submission owns recall authority, independently of live gates",
  );
});

for (const failure of [
  {
    status: 403,
    body: JSON.stringify({ error: "only the submitter or an approver withdraws this estimate" }),
    expected: /only the submitter or an approver/,
  },
  { status: 502, body: "<html>Bad gateway</html>", expected: /status 502/ },
]) {
  test(`withdraw refusal preserves the server cause for HTTP ${failure.status}`, async (t) => {
    script.submittedByViewer = true;
    script.withdraw = pendingSubmission;
    globalThis.__withdrawPrompt = "customer requested a revised estimate";
    const { host, root, priorFetch } = await mount({ failure });
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = priorFetch;
    });
    const button = withdrawButton(host);
    assert.ok(button);
    await act(async () => {
      button.click();
      await tick();
      await tick();
    });
    const toasts = globalThis.__withdrawToasts ?? [];
    assert.equal(
      toasts.some((toast) => toast.kind === "success"),
      false,
    );
    assert.match(toasts.find((toast) => toast.kind === "error")?.message ?? "", failure.expected);
    assert.ok(
      withdrawButton(host),
      "a refused withdrawal must keep the pending submission available",
    );
  });
}

test("cancelling the withdrawal reason keeps the submission pending without a write", async (t) => {
  script.submittedByViewer = true;
  script.withdraw = pendingSubmission;
  globalThis.__withdrawPrompt = null;
  const { host, root, priorFetch } = await mount();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = priorFetch;
  });
  const button = withdrawButton(host);
  assert.ok(button);
  await act(async () => {
    button.click();
    await tick();
  });
  assert.deepEqual(script.posts, []);
  assert.deepEqual(globalThis.__withdrawToasts, []);
  assert.ok(withdrawButton(host));
});
