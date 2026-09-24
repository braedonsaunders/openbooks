import { registerHooks } from 'node:module'

const EMPTY_MODULE = 'openbooks:test-hooks:empty'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { url: EMPTY_MODULE, shortCircuit: true }
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
