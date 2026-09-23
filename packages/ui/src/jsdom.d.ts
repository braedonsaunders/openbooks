// Ambient types for the jsdom component-test harness (mirrors
// web/jsdom.d.ts). jsdom ships no types and is only ever imported by
// *.test.tsx files; production code must never import it.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window;
  }
}
