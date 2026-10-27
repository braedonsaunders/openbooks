import "server-only";

/**
 * Development loads these modules through the bundler so the dev server can
 * compile TypeScript source. The production server build aliases this module
 * to engine-composition.external.ts, whose imports stay outside the bundle.
 */

export function loadFlowModule() {
  return import("@openbooks/engine/flows/module");
}

export function loadEngineComposition() {
  return import("@openbooks/engine/composition/install");
}

export function loadScheduleNoticeHooks() {
  return import("@openbooks/engine/schedule-boards/distribution-hooks");
}

export function loadBusinessDate() {
  return import("@openbooks/engine/platform/business-date/module");
}
