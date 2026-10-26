import 'server-only'
import { Script } from 'node:vm'

/**
 * The governed host API an app backend may call, exactly as the sandbox
 * installs it. Kept beside the draft check so an endpoint that names a call
 * the runtime does not provide is refused when it is drafted, not when the
 * first person submits the form.
 */
export const APP_HOST_API: Readonly<Record<string, readonly string[] | null>> = {
  log: null,
  request: null,
  settings: ['get', 'all'],
  storage: ['get', 'set', 'list', 'delete'],
  records: ['list', 'get'],
  journal: ['create'],
  platform: ['query', 'schema', 'list', 'get', 'create', 'update', 'delete'],
}

const MEMBER = /\bob\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g

/** Strip comments and string literals so prose like "ob.journal.post" is not read as a call. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (match) =>
    match.startsWith('/') ? ' '.repeat(match.length) : `""`)
}

/**
 * Refusals for one backend file: it must parse, define `handler`, and call
 * only the host API above. Parsing compiles without running anything; the
 * handler executes only inside the sandbox.
 */
export function backendSourceErrors(path: string, source: string): string[] {
  const errors: string[] = []
  try {
    new Script(source, { filename: path })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const line = error instanceof Error ? /:(\d+)\n/.exec(error.stack ?? '')?.[1] : undefined
    return [`${path}: syntax error${line ? ` on line ${line}` : ''}: ${message}`]
  }
  const code = codeOnly(source)
  if (!/\bfunction\s+handler\s*\(|\b(?:var|let|const)\s+handler\s*=|\bhandler\s*=\s*(?:function|\()/.test(code)) {
    errors.push(`${path}: must define function handler(request)`)
  }
  const reported = new Set<string>()
  for (const match of code.matchAll(MEMBER)) {
    const [, area, member] = match as unknown as [string, string, string | undefined]
    if (!Object.hasOwn(APP_HOST_API, area)) {
      if (reported.has(area)) continue
      reported.add(area)
      errors.push(`${path}: ob.${area} is not part of the app host API; available: ${Object.keys(APP_HOST_API).map((key) => `ob.${key}`).join(', ')}`)
      continue
    }
    const members = APP_HOST_API[area]
    if (!members || !member || members.includes(member)) continue
    const key = `${area}.${member}`
    if (reported.has(key)) continue
    reported.add(key)
    errors.push(`${path}: ob.${key} is not part of the app host API; ob.${area} provides ${members.map((name) => `${name}()`).join(', ')}`)
  }
  return errors
}
