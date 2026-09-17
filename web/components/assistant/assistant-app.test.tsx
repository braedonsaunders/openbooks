import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { clearDeletedConversations } from "./sidebar-state";

declare global {
  var __assistantTestRouter:
    | { push(url: string): void; refresh(): void; replace(): void; prefetch(): void }
    | undefined;
  var __assistantTestConfirm: boolean | undefined;
}

// jsdom first: the workbench reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assistant",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
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
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__assistantTestRouter}export function usePathname(){return '/assistant'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return globalThis.__assistantTestConfirm ?? true}",
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
const { uiMessageChunkSchema } = await import("ai");
const messages = (await import("../../messages/en")).default;
const { AssistantApp } = await import("./assistant-app");
import type { ConversationSummary, StoredMessage } from "./assistant-app";

type ChatHandle = {
  response: Response;
  push: (chunk: unknown) => void;
  close: () => void;
};

const openChats = new Map<string, ChatHandle>();
const transcripts = new Map<string, StoredMessage[]>();
const deletedConversations: string[] = [];
const abortedRuns: string[] = [];
const routerCalls: string[] = [];
/** Scripted run snapshots for the reattach poll endpoint, per run row id. */
const runSnapshots = new Map<string, { status: string; parts: unknown[]; revision: number }>();

function sseChat(conversationId: string, runId: string): ChatHandle {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  const handle: ChatHandle = {
    response: new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "x-conversation-id": conversationId,
        "x-run-id": runId,
      },
    }),
    async push(chunk: unknown) {
      const schema = uiMessageChunkSchema as unknown as () => {
        validate(value: unknown): Promise<{ success: boolean }>;
      };
      const parsed = await schema().validate(chunk);
      assert.ok(parsed.success, `mock SSE chunk must satisfy the UI-message schema: ${JSON.stringify(chunk)}`);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    close() {
      try { controller.close(); } catch { /* already closed */ }
    },
  };
  openChats.set(conversationId, handle);
  return handle;
}

function installFetch(conversationIds: { a: string; b: string }) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/assistant/chat") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { conversationId?: string | null };
      const id = body.conversationId ?? conversationIds.a;
      return sseChat(id, `run-for-${id}`).response;
    }
    const abortMatch = url.match(/\/api\/assistant\/runs\/([^/]+)\/abort/);
    if (abortMatch && method === "POST") {
      abortedRuns.push(decodeURIComponent(abortMatch[1]!));
      return Response.json({ ok: true });
    }
    const runMatch = url.match(/\/api\/assistant\/runs\/([^/?]+)/);
    if (runMatch && method === "GET") {
      const snapshot = runSnapshots.get(decodeURIComponent(runMatch[1]!));
      if (!snapshot) return Response.json({ run: null });
      return Response.json({
        run: { runId: decodeURIComponent(runMatch[1]!), status: snapshot.status, parts: snapshot.parts, revision: snapshot.revision },
      });
    }
    if (url.endsWith("/api/assistant/conversations")) {
      return Response.json({
        items: [
          { id: conversationIds.a, title: "Chat A", updatedAt: new Date().toISOString() },
          { id: conversationIds.b, title: "Chat B", updatedAt: new Date().toISOString() },
        ],
      });
    }
    const convoMatch = url.match(/\/api\/assistant\/conversations\/([^?]+)/);
    if (convoMatch) {
      const id = decodeURIComponent(convoMatch[1]!);
      if (method === "DELETE") {
        deletedConversations.push(id);
        return Response.json({ ok: true });
      }
      return Response.json({ messages: transcripts.get(id) ?? [], hasOlder: false });
    }
    throw new Error(`unexpected fetch in assistant workbench test: ${method} ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = prior; };
}

type WorkbenchProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  initialMessages: StoredMessage[];
};

function mountWorkbench() {
  globalThis.__assistantTestRouter = {
    push(url: string) { routerCalls.push(`push:${url}`); },
    refresh() { routerCalls.push("refresh"); },
    replace() {},
    prefetch() {},
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next: WorkbenchProps) =>
    act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <AssistantApp
            conversations={next.conversations}
            activeId={next.activeId}
            initialMessages={next.initialMessages}
            canWrite
            aiEnabled
          />
        </NextIntlClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return {
    host,
    render,
    async unmount() {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

async function sendPrompt(host: HTMLElement, text: string) {
  const box = host.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(box, "composer textarea must render");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set as
      | ((this: HTMLTextAreaElement, value: string) => void)
      | undefined;
    setter?.call(box, text);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const send = host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  assert.ok(send, "send button must render");
  await act(async () => {
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function pump(conversationId: string, chunks: unknown[]) {
  const handle = openChats.get(conversationId);
  assert.ok(handle, `expected an open chat stream for ${conversationId}`);
  await act(async () => {
    for (const chunk of chunks) await handle.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function summaries(a: string, b: string): ConversationSummary[] {
  return [
    { id: a, title: "Chat A", updatedAt: new Date().toISOString() },
    { id: b, title: "Chat B", updatedAt: new Date().toISOString() },
  ];
}

/** Run-row data beats StoredMessage's narrow parts-only type via the same shape the server writes. */
const runRowData = (status: string, parts: unknown[], revision?: number) =>
  ({ kind: "agent-turn", status, revision, parts }) as StoredMessage["data"];

const bTranscript: StoredMessage[] = [
  { id: "u-b1", role: "user", content: "b-question", data: null },
  { id: "a-b1", role: "assistant", content: "b-answer", data: null },
];

const TOOL_CHUNKS = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Checking the books" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "profit_and_loss" },
  { type: "tool-input-available", toolCallId: "c1", toolName: "profit_and_loss", input: {} },
];

test("an in-flight turn survives switching chats, keyed by conversation", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  const restoreFetch = installFetch({ a, b });
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    restoreFetch();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });

  await sendPrompt(view.host, "run a profit and loss");
  await pump(a, TOOL_CHUNKS);
  const live = view.host.textContent ?? "";
  assert.ok(live.includes("Checking the books"), "streamed text must be visible mid-turn");
  assert.ok(live.includes("Ran a profit & loss"), "in-progress tool use must be visible mid-turn");

  // Switch to chat B (same mounted view, new props — the App Router reconciliation).
  await view.render({ conversations: summaries(a, b), activeId: b, initialMessages: bTranscript });
  const onB = view.host.textContent ?? "";
  assert.ok(onB.includes("b-answer"), "switching must show chat B's transcript");
  assert.ok(!onB.includes("Checking the books"), "chat A's in-flight turn must not leak into chat B");

  // Return to A while its turn still streams: the live progress must be there.
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  const backOnA = view.host.textContent ?? "";
  assert.ok(backOnA.includes("Checking the books"), "returning must rehydrate the in-flight text");
  assert.ok(backOnA.includes("Ran a profit & loss"), "returning must rehydrate the in-progress tool use");

  // Finish the turn while viewing: the completed answer folds into the base.
  await pump(a, [
    { type: "tool-output-available", toolCallId: "c1", output: { ok: true, data: { total: 42 } } },
    { type: "text-delta", id: "t1", delta: " — done." },
    { type: "text-end", id: "t1" },
  ]);
  openChats.get(a)?.close();
  await act(tick);
  const done = view.host.textContent ?? "";
  assert.ok(done.includes("Checking the books — done."), "the finished answer must land in the viewing chat");
  openChats.delete(a);
});

test("a completed-while-away turn is adopted on return and converges", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  const restoreFetch = installFetch({ a, b });
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    restoreFetch();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });

  await sendPrompt(view.host, "run a trial balance");
  await pump(a, [
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: "Tallying" },
  ]);
  // Switch away; the turn completes while chat B shows.
  await view.render({ conversations: summaries(a, b), activeId: b, initialMessages: bTranscript });
  await pump(a, [
    { type: "text-delta", id: "t2", delta: " — finished away." },
    { type: "text-end", id: "t2" },
  ]);
  openChats.get(a)?.close();
  await act(tick);
  openChats.delete(a);
  // Chat B is undisturbed by A's completion.
  assert.ok((view.host.textContent ?? "").includes("b-answer"));
  assert.ok(!(view.host.textContent ?? "").includes("Tallying"));

  // The server persisted A's turn; returning converges onto it.
  transcripts.set(a, [
    { id: "u-a9", role: "user", content: "run a trial balance", data: null },
    {
      id: "a-a9",
      role: "assistant",
      content: "Tallying — finished away.",
      data: runRowData("complete", [{ type: "text", text: "Tallying — finished away." }]),
    },
  ]);
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await act(tick);
  const backOnA = view.host.textContent ?? "";
  assert.ok(backOnA.includes("Tallying — finished away."), "returning must show the away-completed turn");
  assert.equal((backOnA.match(/Tallying — finished away\./g) ?? []).length, 1, "the converged turn must render exactly once");
});

test("a reload reattaches to the live run via its event log", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  const runRowId = randomUUID();
  const runningRow: StoredMessage = {
    id: runRowId,
    role: "assistant",
    content: "",
    data: runRowData("running", [{ type: "text", text: "Stale server snapshot" }], 2),
    createdAt: new Date().toISOString(),
  };
  transcripts.set(a, [
    { id: "u-a7", role: "user", content: "deep question", data: null },
    runningRow,
  ]);
  transcripts.set(b, bTranscript);
  runSnapshots.set(runRowId, {
    status: "running",
    parts: [{ type: "text", text: "Live progress" }],
    revision: 3,
  });
  const restoreFetch = installFetch({ a, b });
  t.after(() => {
    runSnapshots.delete(runRowId);
    restoreFetch();
  });
  // Fresh mount (page reload): the persisted snapshot shows, then the follow
  // poll adopts the newer server revision.
  const view = mountWorkbench();
  t.after(async () => { await view.unmount(); });
  await view.render({
    conversations: summaries(a, b),
    activeId: a,
    initialMessages: transcripts.get(a)!,
  });
  await act(tick);
  await act(tick);
  const followed = view.host.textContent ?? "";
  assert.ok(
    followed.includes("Live progress"),
    "the reattached view must adopt the live run snapshot",
  );
  assert.ok(
    !followed.includes("Stale server snapshot"),
    "the live tail must replace its running row, not duplicate it",
  );

  // The run completes server-side; the follower converges onto the transcript.
  runSnapshots.set(runRowId, {
    status: "complete",
    parts: [{ type: "text", text: "Final answer." }],
    revision: 4,
  });
  transcripts.set(a, [
    { id: "u-a7", role: "user", content: "deep question", data: null },
    {
      id: runRowId,
      role: "assistant",
      content: "Final answer.",
      data: runRowData("complete", [{ type: "text", text: "Final answer." }]),
    },
  ]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  });
  const converged = view.host.textContent ?? "";
  assert.ok(converged.includes("Final answer."), "the follower must converge on the completed run");
});

test("stopping a turn hits the explicit abort endpoint and clears reading", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  abortedRuns.length = 0;
  const restoreFetch = installFetch({ a, b });
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    restoreFetch();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await sendPrompt(view.host, "long report please");
  await pump(a, [
    { type: "text-start", id: "t3" },
    { type: "text-delta", id: "t3", delta: "Starting" },
  ]);
  const stop = view.host.querySelector('button[aria-label="Stop"]') as HTMLButtonElement;
  assert.ok(stop, "stop button must render while streaming");
  await act(async () => {
    stop.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  assert.ok(abortedRuns.includes(`run-for-${a}`), "stop must abort the server run explicitly");
  openChats.get(a)?.close();
  // The stop-reconcile waits out persistence lag before adopting; poll
  // boundedly instead of asserting mid-flight.
  await act(async () => {
    for (let i = 0; i < 40 && view.host.querySelector('[role="status"]'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  assert.equal(view.host.querySelector('[role="status"]'), null, "the streaming indicator must clear after stop");
  openChats.delete(a);
});

test("deleting another conversation mid-stream leaves the active turn untouched", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  deletedConversations.length = 0;
  routerCalls.length = 0;
  const restoreFetch = installFetch({ a, b });
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    restoreFetch();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });

  await sendPrompt(view.host, "run a trial balance");
  await pump(a, [
    { type: "text-start", id: "t9" },
    { type: "text-delta", id: "t9", delta: "Checking the books" },
  ]);
  assert.ok((view.host.textContent ?? "").includes("Checking the books"));

  // Open chat B's row menu and delete it while A streams.
  const rows = [...view.host.querySelectorAll("li")];
  const rowB = rows.find((li) => li.textContent?.includes("Chat B"));
  assert.ok(rowB, "chat B row must render");
  await act(async () => {
    (rowB.querySelector('button[aria-label="Conversation actions"]') as HTMLButtonElement)?.click();
    await tick();
  });
  const deleteButton = [...view.host.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Delete conversation"),
  );
  assert.ok(deleteButton, "delete action must render");
  await act(async () => {
    deleteButton.click();
    await tick();
    await tick();
  });
  assert.ok(deletedConversations.includes(b), "chat B must be deleted");
  assert.ok(!deletedConversations.includes(a), "chat A must not be deleted");
  const after = view.host.textContent ?? "";
  assert.ok(after.includes("Checking the books"), "the active in-flight turn must survive deleting another chat");
  assert.ok(view.host.querySelector('[role="status"]'), "the streaming indicator must still show");
  openChats.get(a)?.close();
  openChats.delete(a);
});

async function openRowMenuAndDelete(host: HTMLElement, rowTitle: string) {
  const rows = [...host.querySelectorAll("li")];
  const row = rows.find((li) => li.textContent?.includes(rowTitle));
  assert.ok(row, `${rowTitle} row must render`);
  await act(async () => {
    (row.querySelector('button[aria-label="Conversation actions"]') as HTMLButtonElement)?.click();
    await tick();
  });
  const deleteButton = [...host.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Delete conversation"),
  );
  assert.ok(deleteButton, "delete action must render");
  await act(async () => {
    deleteButton.click();
    await tick();
    await tick();
  });
}

function sidebarTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

/** F-user-002: a delete confirmed in the chat menu must survive switching chats. */
test("a deleted thread stays gone when the next chat arrives with a stale server list", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  deletedConversations.length = 0;
  clearDeletedConversations();
  const restoreFetch = installFetch({ a, b });
  const first = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await first.unmount().catch(() => {});
    restoreFetch();
    clearDeletedConversations();
  });
  await first.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  assert.ok(sidebarTitles(first.host).some((s) => s.includes("Chat B")), "chat B must start listed");

  await openRowMenuAndDelete(first.host, "Chat B");
  assert.ok(deletedConversations.includes(b), "chat B must be deleted server-side");
  assert.ok(!sidebarTitles(first.host).some((s) => s.includes("Chat B")), "chat B must leave the sidebar");

  // Switch chats: App Router may remount the panel with a stale prefetched
  // payload that still carries the deleted thread. It must not come back.
  await first.unmount();
  const second = mountWorkbench();
  t.after(async () => {
    await second.unmount().catch(() => {});
  });
  await second.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  assert.ok(
    !sidebarTitles(second.host).some((s) => s.includes("Chat B")),
    "a stale server list must not resurrect the deleted thread after switching chats",
  );
  assert.ok(sidebarTitles(second.host).some((s) => s.includes("Chat A")), "the surviving chat must stay listed");
});

test("a stale sidebar refetch on the same view must not resurrect a deleted thread", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  deletedConversations.length = 0;
  clearDeletedConversations();
  const restoreFetch = installFetch({ a, b });
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    restoreFetch();
    clearDeletedConversations();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await openRowMenuAndDelete(view.host, "Chat B");
  assert.ok(deletedConversations.includes(b), "chat B must be deleted server-side");

  // The next props / refetch still carries the deleted id (stale cache): the
  // sidebar must honour the deletion instead of re-adding the row.
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await act(tick);
  assert.ok(
    !sidebarTitles(view.host).some((s) => s.includes("Chat B")),
    "a stale refetch must not resurrect the deleted thread",
  );
});

test("the sidebar removes the thread optimistically while the delete is in flight", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  deletedConversations.length = 0;
  clearDeletedConversations();
  const restoreFetch = installFetch({ a, b });
  // Hold the DELETE open: the row must already be gone while it is pending.
  const innerFetch = globalThis.fetch;
  let resolveDelete!: (response: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    resolveDelete = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/assistant/conversations/") && (init?.method ?? "GET").toUpperCase() === "DELETE") {
      return gate;
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    globalThis.fetch = innerFetch;
    restoreFetch();
    clearDeletedConversations();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await openRowMenuAndDelete(view.host, "Chat B");
  assert.ok(
    !sidebarTitles(view.host).some((s) => s.includes("Chat B")),
    "the thread must leave the sidebar before the server answers",
  );
  await act(async () => {
    resolveDelete(Response.json({ ok: true }));
    await tick();
    await tick();
  });
  assert.ok(
    !sidebarTitles(view.host).some((s) => s.includes("Chat B")),
    "the thread must stay gone once the server confirms",
  );
});

test("a failed delete restores the row and surfaces the error", async (t) => {
  const a = randomUUID();
  const b = randomUUID();
  transcripts.set(a, []);
  transcripts.set(b, bTranscript);
  deletedConversations.length = 0;
  clearDeletedConversations();
  const restoreFetch = installFetch({ a, b });
  const innerFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/assistant/conversations/") && (init?.method ?? "GET").toUpperCase() === "DELETE") {
      return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  const view = mountWorkbench();
  t.after(async () => {
    for (const [, handle] of openChats) handle.close();
    openChats.clear();
    await view.unmount();
    globalThis.fetch = innerFetch;
    restoreFetch();
    clearDeletedConversations();
  });
  await view.render({ conversations: summaries(a, b), activeId: a, initialMessages: [] });
  await openRowMenuAndDelete(view.host, "Chat B");
  assert.ok(sidebarTitles(view.host).some((s) => s.includes("Chat B")), "a failed delete must restore the row");
  assert.ok(
    (view.host.textContent ?? "").includes("could not be deleted"),
    "a failed delete must surface the error",
  );
});
