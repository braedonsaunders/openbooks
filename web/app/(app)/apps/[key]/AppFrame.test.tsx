import assert from "node:assert/strict";
import test from "node:test";
import type { AbstractIntlMessages } from "next-intl";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/apps/shop", resizeObserver: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messagesEn = (await import("../../../../messages/en"))
  .default as unknown as AbstractIntlMessages;
const messagesDe = (await import("../../../../messages/de"))
  .default as unknown as AbstractIntlMessages;
const { AppFrame } = await import("./AppFrame");

const CONTEXT = {
  app: { id: "app-1", key: "shop", name: "Shop", versionId: "v1" },
  user: null,
};

type Posted = { ok: boolean; error?: unknown; result?: unknown };

async function renderFrame(options: {
  locale: string;
  messages: AbstractIntlMessages;
  previewDraftId?: string;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: options.locale,
        messages: options.messages,
        timeZone: "UTC",
        children: React.createElement(AppFrame, {
          appKey: "shop",
          context: CONTEXT,
          previewDraftId: options.previewDraftId,
        }),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const iframe = host.querySelector("iframe") as HTMLIFrameElement | null;
  assert.ok(iframe, "the frame must render");
  assert.ok(iframe.contentWindow, "the frame window must exist");
  const posted: Posted[] = [];
  const channels: MessageChannel[] = [];
  const proofOf = () => new URL(iframe.src, "http://localhost:4800").searchParams.get("bridge");
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The SDK's side of the handshake: present a proof with one end of a
  // private channel, then talk over that channel only.
  async function handshake(proof: string | null) {
    const channel = new MessageChannel();
    channels.push(channel);
    channel.port1.onmessage = (event: MessageEvent) => {
      posted.push(event.data as Posted);
    };
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new window.Event("message"), {
          source: iframe!.contentWindow,
          data: { __ob: true, type: "ready", proof },
          ports: [channel.port2],
        }),
      );
      await settle();
    });
    return channel;
  }
  return {
    host,
    root,
    iframe,
    posted,
    proofOf,
    handshake,
    async call(method: string, channel?: MessageChannel) {
      const bound = channel ?? (await handshake(proofOf()));
      await act(async () => {
        bound.port1.postMessage({ __ob: true, type: "call", id: "r1", method, payload: {} });
        await settle();
      });
    },
    async windowCall(method: string) {
      await act(async () => {
        window.dispatchEvent(
          Object.assign(new window.Event("message"), {
            source: iframe!.contentWindow,
            data: { __ob: true, type: "call", id: "r1", method, payload: {} },
            ports: [],
          }),
        );
        await settle();
      });
    },
    async navigate() {
      await act(async () => {
        iframe!.dispatchEvent(new window.Event("load"));
        await settle();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      host.remove();
    },
  };
}

// F4T-10: a 200 with a non-JSON body is a failure, not a success — the
// sandbox must get ok:false with the named refusal, never ok:true with an
// empty result and never a SyntaxError string.
test("F4T-10: non-JSON success body refuses with the named error", async () => {
  globalThis.fetch = (async () =>
    new Response("not json", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  const frame = await renderFrame({ locale: "en", messages: messagesEn });
  try {
    await frame.call("records.list");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false, "a non-JSON body must not post success");
    assert.match(String(frame.posted[0]!.error ?? ""), /Bridge call failed/);
  } finally {
    await frame.unmount();
  }
});

// F4T-10: bridge refusals render in the operator locale — under de the
// unknown-method refusal names the method without hardcoded English.
test("F4T-10: unknown method refusal renders in the operator locale", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not fire for an unknown method");
  }) as typeof fetch;
  const frame = await renderFrame({ locale: "de", messages: messagesDe });
  try {
    await frame.call("nope.not-a-method");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false);
    const message = String(frame.posted[0]!.error ?? "");
    assert.ok(message.includes("nope.not-a-method"), `the method must be named, got ${message}`);
    assert.ok(!message.includes("unknown bridge method"), `no hardcoded English, got ${message}`);
  } finally {
    await frame.unmount();
  }
});

// F4T-10: the draft-preview refusal is operator-locale copy, not the
// hardcoded English sentence.
test("F4T-10: draft preview refusal renders in the operator locale", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not fire for a draft preview");
  }) as typeof fetch;
  const frame = await renderFrame({
    locale: "de",
    messages: messagesDe,
    previewDraftId: "draft-1",
  });
  try {
    await frame.call("records.list");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false);
    const message = frame.posted[0]!.error;
    assert.equal(typeof message, "string", "the refusal must be readable copy");
    assert.notEqual(
      message,
      "Draft preview does not execute backend actions or access live data",
      "the refusal must not be the hardcoded English sentence",
    );
  } finally {
    await frame.unmount();
  }
});

test("bridge calls travel only over the channel bound by the document's single-use handshake", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ ok: true, result: { rows: [] } });
  }) as typeof fetch;
  const frame = await renderFrame({ locale: "en", messages: messagesEn });
  try {
    // A bare window message is not a bridge call, whoever sends it.
    await frame.windowCall("records.list");
    assert.equal(fetches, 0);
    // A handshake must present this load's proof.
    const forged = await frame.handshake("00000000-0000-4000-8000-000000000000");
    await frame.call("records.list", forged);
    assert.equal(fetches, 0);
    assert.equal(frame.posted.length, 0);

    const proof = frame.proofOf();
    const bound = await frame.handshake(proof);
    await frame.call("records.list", bound);
    assert.equal(fetches, 1);
    assert.deepEqual(
      frame.posted.map((result) => result.ok),
      [true],
    );

    // The proof is spent: a later document presenting it binds nothing.
    const replay = await frame.handshake(proof);
    await frame.call("records.list", replay);
    assert.equal(fetches, 1);
  } finally {
    await frame.unmount();
  }
});

test("a navigation away from the App revokes its channel and reloads it under a new proof", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ ok: true, result: null });
  }) as typeof fetch;
  const frame = await renderFrame({ locale: "en", messages: messagesEn });
  try {
    await frame.navigate(); // the App document's own load
    const first = frame.proofOf();
    const bound = await frame.handshake(first);
    await frame.navigate(); // an unrequested load: the frame left the App
    await frame.call("records.list", bound);
    assert.equal(fetches, 0, "the revoked channel relays nothing");
    const next = frame.proofOf();
    assert.ok(next && next !== first, "the App reloads under a fresh proof");
    await frame.call("records.list", await frame.handshake(next));
    assert.equal(fetches, 1);
  } finally {
    await frame.unmount();
  }
});
