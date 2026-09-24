import assert from "node:assert/strict";
import test from "node:test";

// F3-66: Withdraw and Cancel rendered for read-only viewers, and an empty
// reason posted. The drawer now hides both unless it holds hrm.leave.request
// (canWithdrawCancel, mirroring the withdraw/cancel route guard), and an
// empty prompt answer never posts.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/leave",
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

let promptAnswer: string | null = null;

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {refresh(){},push(){}}}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (typeof specifier === "string" && specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__leavePromptAnswer}",
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
const { LeaveDrawer } = await import("./LeaveDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const REQUEST_ID = "00000000-0000-4000-8000-000000000031";

function installFetch(posts: string[]): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === `/api/hrm/leave-requests/${REQUEST_ID}` && (init?.method ?? "GET") === "GET") {
      return Response.json({
        request: {
          id: REQUEST_ID,
          employmentId: "00000000-0000-4000-8000-000000000021",
          leaveTypeCode: "PPL-VAC",
          startsOn: "2026-10-01",
          endsOn: "2026-10-02",
          hours: "16",
          reason: "Rest",
          status: "submitted",
          decidedBy: null,
          decisionReason: null,
        },
        timeBalance: null,
        valueBalances: [],
        asOf: "2026-09-20",
      });
    }
    if (url.endsWith("/withdraw") || url.endsWith("/cancel")) {
      posts.push(url);
      return Response.json({ request: { id: REQUEST_ID } });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function buttonByText(text: string): HTMLButtonElement | null {
  // The Drawer portals to document.body, so search the whole document.
  const buttons = Array.from(document.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined) ?? null;
}

async function mountDetail(canWithdrawCancel: boolean, posts: string[]): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  const restore = installFetch(posts);
  (globalThis as Record<string, unknown>).__leavePromptAnswer = promptAnswer;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer requestId={REQUEST_ID} canWithdrawCancel={canWithdrawCancel} onClose={() => {}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      restore();
    },
  };
}

test("a read-only viewer sees no Withdraw button on a submitted request", async () => {
  const posts: string[] = [];
  const m = await mountDetail(false, posts);
  try {
    assert.equal(buttonByText("Withdraw") === null, true, "Withdraw must hide without hrm.leave.request");
  } finally {
    await m.unmount();
  }
});

test("a grant holder sees Withdraw and an empty reason never posts", async () => {
  const posts: string[] = [];
  promptAnswer = "   ";
  const m = await mountDetail(true, posts);
  try {
    const withdraw = buttonByText("Withdraw");
    assert.ok(withdraw, "Withdraw must render with hrm.leave.request");
    await act(async () => {
      withdraw.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.deepEqual(posts, [], "a whitespace-only reason must not reach the withdraw route");
  } finally {
    await m.unmount();
    promptAnswer = null;
  }
});

test("a grant holder posts a real reason to withdraw", async () => {
  const posts: string[] = [];
  promptAnswer = "Plans changed";
  const m = await mountDetail(true, posts);
  try {
    const withdraw = buttonByText("Withdraw");
    assert.ok(withdraw);
    await act(async () => {
      withdraw.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.equal(posts.length, 1, "a real reason must post exactly once");
    assert.match(posts[0] ?? "", /\/withdraw$/);
  } finally {
    await m.unmount();
    promptAnswer = null;
  }
});
