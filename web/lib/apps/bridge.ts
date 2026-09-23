/**
 * App bridge — the postMessage protocol between a sandboxed App frontend and
 * the host page. Pure module (no server-only, no React): shared by the injected
 * client SDK (runs inside the iframe), the AppFrame host (parent), and tests.
 *
 * Trust model: the App frontend runs in an opaque-origin sandboxed iframe
 * (sandbox="allow-scripts", no allow-same-origin) — it has no cookies, no
 * access to the parent DOM, and CSP `connect-src 'none'` blocks its own
 * network. The ONLY way it reaches data is these bridge calls, which the host
 * relays to permission-checked server routes. The parent validates that every
 * inbound message came from its own iframe (event.source identity) before
 * relaying; the child validates that results came from window.parent.
 */

export const BRIDGE_MARKER = '__ob' as const

/** Methods the host relays to the server (getContext is answered locally). */
export const BRIDGE_METHODS = [
  'callBackend',
  'records.list',
  'records.get',
  'platform.query',
  'platform.schema',
  'platform.list',
  'platform.get',
  'platform.create',
  'platform.update',
  'platform.delete',
] as const
export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

export interface BridgeContext {
  /** Informational sample-mode flag; the host independently refuses preview bridge calls. */
  preview?: boolean
  app: { id: string; key: string; name: string; versionId?: string }
  user: { id: string; name: string; roles: string[] } | null
}

export interface BridgeRequest {
  [BRIDGE_MARKER]: true
  type: 'call'
  id: string
  method: string
  payload: unknown
  /**
   * Client-generated invocation key (one per intended action, preserved
   * across that action's retries). The SDK always sends one; absent here
   * only from a malformed envelope, which writes refuse downstream.
   */
  invocationKey?: string
}

export interface BridgeResult {
  [BRIDGE_MARKER]: true
  type: 'result'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/** Narrow an untrusted postMessage payload to a BridgeRequest, or null. */
export function parseBridgeRequest(data: unknown): BridgeRequest | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d[BRIDGE_MARKER] !== true || d.type !== 'call') return null
  if (typeof d.id !== 'string' || typeof d.method !== 'string') return null
  return {
    [BRIDGE_MARKER]: true,
    type: 'call',
    id: d.id,
    method: d.method,
    payload: d.payload,
    ...(typeof d.invocationKey === 'string' ? { invocationKey: d.invocationKey } : {}),
  }
}

export function makeBridgeResult(id: string, ok: boolean, resultOrError: unknown): BridgeResult {
  return ok
    ? { [BRIDGE_MARKER]: true, type: 'result', id, ok: true, result: resultOrError }
    : { [BRIDGE_MARKER]: true, type: 'result', id, ok: false, error: String(resultOrError) }
}

export function isBridgeMethod(method: string): method is BridgeMethod {
  return (BRIDGE_METHODS as readonly string[]).includes(method)
}

/**
 * The Content-Security-Policy injected into every App document. `default-src
 * 'none'` denies everything, then we re-allow only inline + data: for the
 * inlined bundle, and `connect-src 'none'` forbids the App from making its own
 * network calls — all I/O must go through the bridge (postMessage is exempt).
 */
export const APP_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' data:; " +
  "style-src 'unsafe-inline' data:; " +
  "img-src data:; " +
  "font-src data:; " +
  "connect-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'"

/**
 * The client SDK source injected into the iframe as an inline <script>. Exposes
 * window.openbooks with the embedded context plus promise-based bridge calls.
 * Written as a plain string (not a bundled module) so it needs no build step
 * and runs in the sandbox's fresh realm.
 */
export function bridgeClientSource(context: BridgeContext): string {
  return `(function(){
  var CTX = ${JSON.stringify(context).replace(/</g, '\\u003c')};
  var pending = {};
  var seq = 0;
  window.addEventListener('message', function(e){
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d['${BRIDGE_MARKER}'] !== true || d.type !== 'result') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || 'bridge error'));
  });
  function uuid(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function call(method, payload, invocationKey){
    return new Promise(function(resolve, reject){
      var id = 'c' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ '${BRIDGE_MARKER}': true, type: 'call', id: id, method: method, payload: payload, invocationKey: invocationKey || uuid() }, '*');
    });
  }
  // Mutating calls accept an explicit invocation key so the action can be
  // retried with the same key (same invocation replays); without one the SDK
  // mints a fresh uuid per call, so every intentional repeat runs.
  function actionKey(opts){ return opts && opts.invocationKey; }
  window.openbooks = {
    context: CTX,
    getContext: function(){ return Promise.resolve(CTX); },
    callBackend: function(endpoint, payload, opts){ return call('callBackend', { endpoint: endpoint, payload: payload }, actionKey(opts)); },
    records: {
      list: function(typeKey, filters){ return call('records.list', { typeKey: typeKey, filters: filters || {} }); },
      get: function(typeKey, id){ return call('records.get', { typeKey: typeKey, id: id }); }
    },
    platform: {
      query: function(plan){ return call('platform.query', { plan: plan }); },
      schema: function(){ return call('platform.schema', {}); },
      list: function(typeKey, options){ return call('platform.list', { typeKey: typeKey, options: options || {} }); },
      get: function(typeKey, id){ return call('platform.get', { typeKey: typeKey, id: id }); },
      create: function(typeKey, body, opts){ return call('platform.create', { typeKey: typeKey, body: body || {} }, actionKey(opts)); },
      update: function(typeKey, id, body, opts){ return call('platform.update', { typeKey: typeKey, id: id, body: body || {} }, actionKey(opts)); },
      delete: function(typeKey, id, opts){ return call('platform.delete', { typeKey: typeKey, id: id }, actionKey(opts)); }
    }
  };
  window.parent.postMessage({ '${BRIDGE_MARKER}': true, type: 'ready' }, '*');
})();`
}

/**
 * Assemble the final single-document HTML served into the sandboxed iframe.
 * Pure string transform (testable): substitute each bundle asset reference with
 * its precomputed data: URL, then inject `headHtml` (CSP meta + SDK script) into
 * <head>. Inlining as data: URLs — not parent-minted blob: URLs — is deliberate:
 * a null-origin sandboxed iframe cannot fetch the parent origin's blob URLs, but
 * data: URLs are self-contained and origin-agnostic.
 */
export function inlineDocument(
  entryHtml: string,
  replacements: Record<string, string>,
  headHtml: string,
  entry = '',
): string {
  const directory = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : ''
  let html = entryHtml.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (attribute, name: string, quote: string, reference: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) return attribute
    const path = reference.split(/[?#]/)[0]!
    const parts: string[] = []
    for (const part of (path.startsWith('/') ? path.slice(1) : directory + path).split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) return attribute; parts.pop() } else parts.push(part)
    }
    const resolved = replacements[parts.join('/')] ?? replacements[path.replace(/^\.?\//, '')]
    return resolved ? `${name}=${quote}${resolved}${quote}` : attribute
  })
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + headHtml)
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => m + '<head>' + headHtml + '</head>')
  } else {
    html = headHtml + html
  }
  return html
}
