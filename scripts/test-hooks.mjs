import { registerHooks } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EMPTY_MODULE = 'openbooks:test-hooks:empty'
// web/tsconfig.json maps the `@/*` house alias onto the web root. Mirror it
// here so `@/` resolves under node --test even when TSX_TSCONFIG_PATH is
// unset (tsx maps the same target when it is set — identical outcome, and
// per-file mock hooks registered later still take precedence).
const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'web')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { url: EMPTY_MODULE, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(resolvePath(WEB_ROOT, specifier.slice(2))).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === EMPTY_MODULE) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
