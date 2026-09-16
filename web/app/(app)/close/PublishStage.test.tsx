import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = pathToFileURL(`${process.cwd()}/`).href;

// The wizard must let the operator supply the publication note the engine
// requires: a first publication accepts an optional note, but re-publishing
// a corrected package after a controlled reopen is refused without a
// restatement note — and the publish button previously sent no comment at
// all, so a restatement died with a 422 and no way to comply.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react" && context.parentURL?.startsWith("data:")) {
      return next(root + "node_modules/react/index.js", context);
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,import { createElement } from 'react'; export default function Link(p) { return createElement('a', { href: p.href }, p.children) }`,
      };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useRouter() { return { refresh() {}, push() {}, replace() {} } }`,
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast = { success() {}, error() {} }`,
      };
    }
    if (specifier === "next-intl") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useTranslations() { return (key) => key }`,
      };
    }
    if (specifier === "../../../components/page-layout") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,import { createElement } from 'react'; export function WizardLayout(p) { return createElement('div', null, p.children) }`,
      };
    }
    return next(specifier, context);
  },
});

const { PublishStage } = await import("./CloseWizard.tsx");

function propsFor(run: Record<string, unknown>) {
  return {
    run,
    tasks: [],
    exceptions: [],
    evidence: [],
    signoffs: [],
    events: [],
    locks: [],
    canRun: true,
    canApprove: false,
    canReopen: false,
    canManageFlows: false,
    subsidiaryEnabled: false,
    multiCurrency: false,
    advancedClose: true,
    busy: false,
    onAction: () => {},
  };
}

const closedRun = {
  id: "run-1",
  status: "closed",
  binder_hash: null,
  package_name: "Close package",
  package_reports: [],
};

// Tailwind `disabled:` variant classes contain the substring, so match the
// rendered disabled attribute (followed by whitespace, `=""`, or the tag
// close) on the publish button instead.
const publishDisabled = (html: string) =>
  /<button[^>]*\sdisabled(="")?[\s>]/.test(html);

test("first publication offers an optional note and stays enabled", () => {
  const html = renderToStaticMarkup(
    createElement(PublishStage, propsFor(closedRun) as never),
  );
  assert.ok(html.includes("<textarea"), "publish must offer a note field");
  assert.ok(
    !publishDisabled(html),
    "first publication without a note must stay enabled",
  );
});

test("re-publication requires a restatement note before enabling publish", () => {
  const html = renderToStaticMarkup(
    createElement(
      PublishStage,
      propsFor({ ...closedRun, binder_hash: "v1hash" }) as never,
    ),
  );
  assert.ok(html.includes("<textarea"), "re-publish must offer a note field");
  assert.ok(
    publishDisabled(html),
    "re-publish without a restatement note must stay disabled",
  );
});
