import type { EditableAppPackage } from './package-files'

/**
 * A small editable starting point using either supported renderer. No grants
 * or live objects. Ships one sample read-only assistant tool (served by the
 * sample backend endpoint) so the New-app flow demonstrates declared tools.
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
                        header: [{ kind: 'page-header', title: 'My app' }],
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
                '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>My app</title>\n  <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n  <main><h1>My app</h1><p>Your app starts here.</p></main>\n  <script src="./app.js"></script>\n</body>\n</html>\n',
            },
            {
              path: 'frontend/styles.css',
              content:
                'body { margin: 0; padding: 2rem; font-family: system-ui, sans-serif; color: #0f172a; }\n',
            },
            {
              path: 'frontend/app.js',
              content:
                '// Use the OpenBooks bridge for governed records, actions, and app storage.\n',
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
