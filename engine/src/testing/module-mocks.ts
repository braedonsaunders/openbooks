import { registerHooks } from "node:module";

export type MockMatch = string | ((specifier: string) => boolean);

function matches(match: MockMatch, specifier: string): boolean {
  return typeof match === "function" ? match(specifier) : specifier === match;
}

/** Register ESM mock sources for `specifier`, import it, then deregister hooks. */
export async function importWithMocks<T>(
  specifier: string | URL,
  mocks: ReadonlyArray<readonly [MockMatch, string]>,
  parentURL: string,
): Promise<T> {
  const sources = new Map<string, string>();
  let seq = 0;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const [match, source] of mocks) {
        if (!matches(match, specifier)) continue;
        const url = `openbooks:mock:${seq++}`;
        sources.set(url, source);
        return { url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = sources.get(url);
      if (source !== undefined) {
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  try {
    const href =
      typeof specifier === "string"
        ? new URL(specifier, parentURL).href
        : specifier.href;
    return (await import(href)) as T;
  } finally {
    hooks.deregister();
  }
}
