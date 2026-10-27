import "server-only";

/**
 * Production server loader. webpackIgnore leaves a real Node import of the
 * prebuilt package, so the composition root — and every domain it installs —
 * is not compiled into each route and page bundle. The dev module of the same
 * name bundles source instead. Keep the two export lists identical.
 */

export function loadFlowModule() {
  return import(/* webpackIgnore: true */ "@openbooks/engine/flows/module");
}

export function loadEngineComposition() {
  return import(/* webpackIgnore: true */ "@openbooks/engine/composition/install");
}

export function loadScheduleNoticeHooks() {
  return import(
    /* webpackIgnore: true */
    "@openbooks/engine/schedule-boards/distribution-hooks"
  );
}

export function loadBusinessDate() {
  return import(/* webpackIgnore: true */ "@openbooks/engine/platform/business-date/module");
}
