import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

stubModules({
  navigation: {
    source:
      "export function useRouter(){return{push(){},refresh(){},replace(){},back(){},forward(){}}}" +
      "export function usePathname(){return globalThis.__journalLinkPath}" +
      "export function useSearchParams(){return new URLSearchParams(globalThis.__journalLinkQuery)}",
  },
  extra: {
    "next/link":
      "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { JournalEntryLink } = await import("./journal-entry-link");

const ENTRY_ID = "0192a0b0-0000-7000-8000-000000000001";

function hrefOf(path: string, query: string): string {
  Object.assign(globalThis, { __journalLinkPath: path, __journalLinkQuery: query });
  const markup = renderToStaticMarkup(<JournalEntryLink entryId={ENTRY_ID}>JE-1</JournalEntryLink>);
  const href = /href="([^"]*)"/.exec(markup)?.[1];
  assert.ok(href, "the posted entry renders as a link");
  return href.replaceAll("&amp;", "&");
}

test("a posted entry opens over the current record without leaving its page", () => {
  assert.equal(
    hrefOf("/revenue/contract-costs", "asset=asset-1"),
    `/revenue/contract-costs?asset=asset-1&txn=${ENTRY_ID}`,
  );
});

test("on the journal page a posted entry replaces any open manual journal document", () => {
  const href = new URL(
    hrefOf("/journal", "entry=doc-1&mode=edit&journalTab=drafts"),
    "http://localhost",
  );
  assert.equal(href.pathname, "/journal");
  assert.equal(href.searchParams.get("journalEntry"), ENTRY_ID);
  assert.equal(href.searchParams.has("entry"), false, "the manual-journal document key is cleared");
  assert.equal(href.searchParams.has("mode"), false);
  assert.equal(href.searchParams.get("journalTab"), "drafts", "unrelated page state survives");
});
