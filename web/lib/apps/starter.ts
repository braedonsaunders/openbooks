import type { AppPackageFile, EditableAppPackage } from './package-files'

/**
 * A small editable starting point using either supported renderer. No grants
 * or live objects. Ships one sample read-only assistant tool (served by the
 * sample backend endpoint) so the New-app flow demonstrates declared tools.
 *
 * The starter's visible title FOLLOWS the app name until the author
 * deliberately customizes it. The native header binds `{ $: 'name' }`, which
 * the runtime resolves against the installed app name; the sandbox heading
 * carries a `data-app-title` marker that `frontend/app.js` fills from the
 * bridge context. Customizing the screen title (native) or removing the
 * marker (sandbox) opts out, and that custom content is never rewritten.
 */
export function createAppStarter(
  renderer: 'native' | 'sandbox',
): EditableAppPackage {
  return {
    manifest: {
      key: 'my-app',
      name: 'My app',
      version: '1.0.0',
      permissions: [],
      frontend: {
        renderer,
        entry:
          renderer === 'native' ? 'frontend/ui.json' : 'frontend/index.html',
      },
      endpoints: [{ name: 'sample-tool', file: 'backend/sample-tool.js' }],
      tools: [
        {
          key: 'sample-tool',
          title: 'Sample tool',
          description: 'Echoes a short query back; replace with a real capability.',
          inputSchema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'Text to echo', maxLength: 200 },
            },
            required: ['q'],
          },
          handler: 'sample-tool',
        },
      ],
    },
    files: [
      ...(renderer === 'native'
        ? [
            {
              path: 'frontend/ui.json',
              content: JSON.stringify(
                {
                  screens: [
                    {
                      key: 'home',
                      title: 'Home',
                      kind: 'page',
                      spec: {
                        specVersion: 1,
                        layout: 'list',
                        // Bound to the installed app name at render time, so
                        // renaming the app renames this heading. Replacing it
                        // with literal text opts out: the custom title is kept.
                        header: [{ kind: 'page-header', title: { $: 'name' } }],
                        body: [
                          { kind: 'text', content: 'Your app starts here.' },
                        ],
                      },
                    },
                  ],
                },
                null,
                2,
              ),
            },
          ]
        : [
            {
              path: 'frontend/index.html',
              content:
                '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>My app</title>\n  <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n  <main><h1 data-app-title>My app</h1><p>Your app starts here.</p></main>\n  <script src="./app.js"></script>\n</body>\n</html>\n',
            },
            {
              path: 'frontend/styles.css',
              content:
                'body { margin: 0; padding: 2rem; font-family: system-ui, sans-serif; color: #0f172a; }\n',
            },
            {
              path: 'frontend/app.js',
              content:
                '// Use the OpenBooks bridge for governed records, actions, and app storage.\n//\n// Starter title binding: the heading marked with [data-app-title] follows\n// the installed app name (window.openbooks.context.app.name) until the\n// author customizes it. To keep a fixed custom heading, edit the heading in\n// frontend/index.html and remove its data-app-title attribute; this script\n// will then leave the heading — and a customized document title — untouched.\n(function () {\n  function appName() {\n    var bridge = typeof window !== "undefined" ? window.openbooks : undefined;\n    var name = bridge && bridge.context && bridge.context.app && bridge.context.app.name;\n    return typeof name === "string" && name.trim() ? name : null;\n  }\n  function apply() {\n    var name = appName();\n    if (!name) return;\n    var heading = document.querySelector("[data-app-title]");\n    if (heading) heading.textContent = name;\n    // A deliberately customized <title> is preserved: only the starter\n    // default (matching frontend/index.html above) follows the app name.\n    if (document.title === "My app") document.title = name;\n  }\n  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);\n  else apply();\n})();\n',
            },
          ]),
      {
        path: 'backend/sample-tool.js',
        content:
          '// Sample backend for the starter assistant tool: echo a bounded query.\nfunction handler(req) {\n  const body = req.body && typeof req.body === "object" ? req.body : {}\n  const q = typeof body.q === "string" ? body.q : ""\n  return { status: 200, body: { echo: q.slice(0, 200) } }\n}\n',
      },
    ],
  }
}

export type StarterTitleBinding = 'follows-name' | 'custom' | 'unknown'

/**
 * Does the package's main screen heading follow the app name, or is it fixed
 * custom text? The editor uses this to say which one renaming will move.
 * Structural read only: it never rewrites anything, and anything it cannot
 * recognize reports `unknown` (no guidance) rather than guessing.
 */
export function starterTitleState(
  files: Pick<AppPackageFile, 'path' | 'content' | 'isBinary'>[],
  frontend: { renderer: 'native' | 'sandbox'; entry: string },
): StarterTitleBinding {
  const entry = files.find((file) => file.path === frontend.entry)
  if (!entry) return 'unknown'
  if (frontend.renderer === 'sandbox') {
    if (!entry.content.includes('data-app-title')) return 'custom'
    // The marker alone does nothing: the shipped script must still fill it
    // from the bridge context. Without the binder the heading is static, so
    // the editor must not promise that it follows.
    const bound = files.some(
      (file) =>
        !file.isBinary &&
        file.path.endsWith('.js') &&
        file.content.includes('data-app-title') &&
        file.content.includes('openbooks'),
    )
    return bound ? 'follows-name' : 'custom'
  }
  let ui: unknown
  try {
    ui = JSON.parse(entry.content)
  } catch {
    return 'unknown'
  }
  const screens =
    typeof ui === 'object' && ui !== null
      ? (ui as { screens?: unknown }).screens
      : undefined
  if (!Array.isArray(screens) || screens.length === 0) return 'unknown'
  const first = screens[0] as { kind?: unknown; spec?: { header?: unknown } }
  if (typeof first !== 'object' || first === null || first.kind !== 'page')
    return 'unknown'
  const header = first.spec?.header
  if (!Array.isArray(header)) return 'unknown'
  const pageHeader = header.find(
    (block): block is { title?: unknown } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { kind?: unknown }).kind === 'page-header',
  )
  if (!pageHeader) return 'unknown'
  return isAppNameRef(pageHeader.title) ? 'follows-name' : 'custom'
}

/**
 * The ViewSpec field-reference contract (`{ $: path }`) narrowed to the app
 * name. Kept structural here so the starter module does not grow a runtime
 * dependency for one shape check.
 */
function isAppNameRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const keys = Object.keys(value)
  return (
    keys.length === 1 &&
    (value as { $?: unknown }).$ === 'name'
  )
}
