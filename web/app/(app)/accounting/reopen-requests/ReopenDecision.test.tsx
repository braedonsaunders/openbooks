import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __reopenTestRouter:
    { push(url: string): void; refresh(): void; replace(url: string): void } | undefined;
  var __reopenTestToasts: { kind: string; message: string }[] | undefined;
  /** Reason the prompt answers with; null models a cancelled prompt. */
  var __reopenTestPrompt: string | null | undefined;
  var __reopenTestPromptCalls: { title: string; multiline?: boolean }[] | undefined;
}

// jsdom first: the decision control reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/accounting/reopen-requests",
  matchMediaMatches: false,
  scrollIntoView: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__reopenTestRouter}export function usePathname(){return '/accounting/reopen-requests'}export function useSearchParams(){return new URLSearchParams()}",
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__reopenTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__reopenTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
      };
    }
    // Shared components import the prompt through "@/lib/prompt"; the suffix match covers that spelling.
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function promptDialog(options){(globalThis.__reopenTestPromptCalls??=[]).push({title:options.title,multiline:options.multiline});return globalThis.__reopenTestPrompt??null}`,
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
const { ReopenDecision } = await import("./ReopenDecision");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mountDecision(requestId: string, ownRequest: boolean) {
  globalThis.__reopenTestRouter = { push() {}, refresh() {}, replace() {} };
  globalThis.__reopenTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ReopenDecision requestId={requestId} ownRequest={ownRequest} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function buttonNamed(label: string) {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}
function nativeBoundary(
  input: { canDecide?: boolean; refusal?: string },
  posts: { url: string; body: Record<string, unknown> }[],
) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/flows/record-state"))
      return Response.json({
        approvalState: {
          status: "requested",
          pendingWith: [],
          myActions: input.canDecide ? { gateId: "gate-1", signatureRequired: false } : null,
        },
        history: [],
        failedRun: null,
        canRetry: false,
      });
    posts.push({ url: path, body: JSON.parse(String(init?.body ?? "{}")) });
    return input.refusal
      ? Response.json({ error: input.refusal }, { status: 409 })
      : Response.json({ ok: true, resumed: null });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

test("a configured reviewer decides the native gate and retains an actionable refusal", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [],
    restore = nativeBoundary(
      {
        canDecide: true,
        refusal: "This submission changed. Recall it and resubmit the current record.",
      },
      posts,
    );
  const mounted = await mountDecision("request-1", false);
  try {
    const approve = buttonNamed("Approve");
    assert.ok(approve);
    await act(async () => {
      approve.click();
      await tick();
    });
    assert.deepEqual(posts, [
      { url: "/api/flows/gates/decide", body: { gateId: "gate-1", decision: "approved" } },
    ]);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Recall it and resubmit/,
    );
  } finally {
    await mounted.unmount();
    restore();
  }
});

test("the requester has the same native gate capability when its tenant permits it", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [],
    restore = nativeBoundary({ canDecide: true }, posts);
  const mounted = await mountDecision("request-2", true);
  try {
    assert.ok(buttonNamed("Approve"));
    assert.ok(buttonNamed("Withdraw request"));
    await act(async () => {
      buttonNamed("Approve")!.click();
      await tick();
    });
    assert.equal(posts[0]?.url, "/api/flows/gates/decide");
    assert.equal(posts[0]?.body.gateId, "gate-1");
  } finally {
    await mounted.unmount();
    restore();
  }
});

test("withdrawal is an owned native command and cancelling its reason writes nothing", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [],
    restore = nativeBoundary({}, posts);
  const mounted = await mountDecision("request-3", true);
  try {
    assert.equal(buttonNamed("Approve"), undefined);
    globalThis.__reopenTestPrompt = null;
    await act(async () => {
      buttonNamed("Withdraw request")!.click();
      await tick();
    });
    assert.deepEqual(posts, []);
    globalThis.__reopenTestPrompt = "The correction is no longer required";
    await act(async () => {
      buttonNamed("Withdraw request")!.click();
      await tick();
    });
    assert.deepEqual(posts, [
      {
        url: "/api/admin/close",
        body: {
          action: "withdraw-reopen",
          requestId: "request-3",
          reason: "The correction is no longer required",
        },
      },
    ]);
  } finally {
    await mounted.unmount();
    restore();
  }
});
