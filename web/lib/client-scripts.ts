'use client'

/**
 * Client scripts — form-level validation hooks that run in the BROWSER, but
 * never in the host page. Each save spins the org's active 'client' scripts
 * for the document kind through a throwaway OPAQUE-ORIGIN sandboxed iframe
 * (sandbox="allow-scripts": no cookies, no parent DOM, no host origin), the
 * same isolation model as App frontends — deliberately NOT NetSuite's
 * in-page client scripts.
 *
 * Script contract:  function main(ctx)   ctx = { kind, doc }
 *   return { abort: "reason" }      block the save with that message
 *   return { warnings: ["..."] }    save proceeds, warnings are toasted
 *   return anything else / nothing  save proceeds
 *
 * Failure posture: fail-open. A script that throws or an evaluator that never
 * answers must not brick data entry — errors surface as console warnings, and
 * only an explicit { abort } blocks.
 */

export interface ClientScriptGate {
  ok: boolean
  reason?: string
  warnings: string[]
}

interface DeliveredScript {
  id: string
  name: string
  source: string
}

const EVALUATOR_TIMEOUT_MS = 2000
const cache = new Map<string, { at: number; scripts: DeliveredScript[] }>()
const CACHE_MS = 30_000

async function fetchScripts(kind: string): Promise<DeliveredScript[]> {
  const hit = cache.get(kind)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.scripts
  try {
    const res = await fetch(`/api/scripts/client?documentKind=${encodeURIComponent(kind)}`, {
      credentials: 'same-origin',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { scripts: DeliveredScript[] }
    cache.set(kind, { at: Date.now(), scripts: json.scripts ?? [] })
    return json.scripts ?? []
  } catch {
    return []
  }
}

/** The evaluator document injected into the throwaway sandbox. */
const EVALUATOR_HTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"></head><body><script>
window.addEventListener('message', function (e) {
  if (e.source !== window.parent) return;
  var scripts = e.data && e.data.scripts, ctx = e.data && e.data.ctx, out = [];
  if (!Array.isArray(scripts)) return;
  for (var i = 0; i < scripts.length; i++) {
    var s = scripts[i];
    try {
      var fn = new Function('ctx', s.source + '\\n;if (typeof main !== "function") throw new Error("script must define function main(ctx)"); return main(ctx);');
      var r = fn(ctx);
      out.push({ id: s.id, name: s.name, result: (r === undefined ? null : r) });
    } catch (err) {
      out.push({ id: s.id, name: s.name, error: String((err && err.message) || err) });
    }
  }
  window.parent.postMessage({ __obClientScripts: true, results: out }, '*');
});
window.parent.postMessage({ __obClientScripts: true, ready: true }, '*');
</script></body></html>`

interface EvalResult {
  id: string
  name: string
  result?: unknown
  error?: string
}

function runInSandbox(scripts: DeliveredScript[], ctx: unknown): Promise<EvalResult[] | null> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.style.display = 'none'
    iframe.srcdoc = EVALUATOR_HTML

    let done = false
    const finish = (v: EvalResult[] | null) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      iframe.remove()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), EVALUATOR_TIMEOUT_MS)

    function onMessage(e: MessageEvent) {
      if (e.source !== iframe.contentWindow) return
      const d = e.data as { __obClientScripts?: boolean; ready?: boolean; results?: EvalResult[] }
      if (!d?.__obClientScripts) return
      if (d.ready) {
        iframe.contentWindow?.postMessage({ scripts, ctx }, '*')
        return
      }
      if (Array.isArray(d.results)) {
        clearTimeout(timer)
        finish(d.results)
      }
    }
    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}

/**
 * Run every active client script for a document kind against the about-to-save
 * payload. Returns the gate the form should honor before writing.
 */
export async function runClientScripts(kind: string, doc: unknown): Promise<ClientScriptGate> {
  const scripts = await fetchScripts(kind)
  if (scripts.length === 0) return { ok: true, warnings: [] }

  const results = await runInSandbox(scripts, { kind, doc })
  if (!results) {
    console.warn('[client-scripts] evaluator timed out — save proceeds (fail-open)')
    return { ok: true, warnings: [] }
  }

  const warnings: string[] = []
  for (const r of results) {
    if (r.error) {
      console.warn(`[client-scripts] "${r.name}" failed:`, r.error)
      continue
    }
    const out = r.result as { abort?: unknown; warnings?: unknown } | null
    if (out && typeof out === 'object') {
      if (typeof out.abort === 'string' && out.abort) {
        return { ok: false, reason: `${r.name}: ${out.abort}`, warnings }
      }
      if (Array.isArray(out.warnings)) {
        for (const w of out.warnings) if (typeof w === 'string') warnings.push(`${r.name}: ${w}`)
      }
    }
  }
  return { ok: true, warnings }
}
