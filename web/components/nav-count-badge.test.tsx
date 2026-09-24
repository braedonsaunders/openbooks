import assert from "node:assert/strict";
import test from "node:test";

// F5-9: NavCountBadge hardcoded its English aria-label ("N items waiting"),
// so a non-en screen-reader user heard English on shared shell chrome that
// renders on every page. The label must pluralize through the catalog.
//
// Only the count route is doubled. React, next-intl and the REAL French
// catalog run, so the hardcoded template fails every assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/dashboard",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/fr")).default;
const { NavCountBadge } = await import("./nav-count-badge");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderBadge(count: number) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ count })) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <NavCountBadge source="/api/inbox/count" />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  return {
    host,
    root,
    done: async () => {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = prior;
    },
  };
}

test("F5-9: the inbox badge aria-label pluralizes in the session locale", async () => {
  const many = await renderBadge(3);
  try {
    const badge = many.host.querySelector("span[aria-label]");
    assert.ok(badge, "the badge must render for a nonzero count");
    assert.equal(badge.getAttribute("aria-label"), "3 éléments en attente");
  } finally {
    await many.done();
  }

  const one = await renderBadge(1);
  try {
    const badge = one.host.querySelector("span[aria-label]");
    assert.ok(badge, "the badge must render for a single item");
    assert.equal(badge.getAttribute("aria-label"), "1 élément en attente");
  } finally {
    await one.done();
  }
});

const messagesEn = (await import("../messages/en")).default;

async function renderBadgeWith(fetchImpl: typeof fetch, source: string) {
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = async (next: string) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messagesEn} timeZone="UTC">
          <NavCountBadge source={next} />
        </NextIntlClientProvider>,
      );
      await tick();
      await tick();
    });
  };
  await show(source);
  return {
    host,
    show,
    done: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = prior;
    },
  };
}

test("B2-NAV-1: the badge clears when the count route errors after a good read", async () => {
  const good = (async () => Response.json({ count: 5 })) as typeof fetch;
  const bad = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const badge = await renderBadgeWith(good, "/api/count-good");
  try {
    assert.match(badge.host.innerHTML, /5 items waiting/, "a live count badges");
    // Switching source re-runs the load; the erroring route must clear
    // the stale 5 rather than keep badging it.
    globalThis.fetch = bad;
    await badge.show("/api/count-bad");
    assert.equal(badge.host.innerHTML, "", "an erroring route clears the badge");
  } finally {
    await badge.done();
  }
});

test("B2-NAV-1: the badge clears when the count route is unreachable", async () => {
  const good = (async () => Response.json({ count: 3 })) as typeof fetch;
  const down = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const badge = await renderBadgeWith(good, "/api/count-good");
  try {
    assert.match(badge.host.innerHTML, /3 items waiting/);
    globalThis.fetch = down;
    await badge.show("/api/count-down");
    assert.equal(badge.host.innerHTML, "", "an unreachable route clears the badge");
  } finally {
    await badge.done();
  }
});
