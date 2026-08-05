// Pretty-print template source HTML so the raw-HTML tab (and the stored
// source_html) is human-readable. Uses prettier's standalone build so the SAME
// code path runs in the save routes (Node) and the editor (browser).
//
// `htmlWhitespaceSensitivity: 'css'` keeps whitespace around inline elements
// significant, so formatting is render-neutral; table structure and the
// data-each/data-if repeat markers are plain attributes and pass through
// untouched. Formatting failures fall back to the input — never block a save.

import { format } from 'prettier/standalone'
// Namespace imports: the plugin packages ship dual CJS/ESM and their `default`
// export is undefined under some interop modes; the namespace always carries
// the plugin shape (languages/parsers/printers).
import * as htmlPluginNs from 'prettier/plugins/html'
import * as cssPluginNs from 'prettier/plugins/postcss'

import type { Plugin } from 'prettier'

const asPlugin = (ns: unknown): Plugin => {
  const mod = ns as { languages?: unknown; default?: unknown }
  return (mod.languages ? mod : (mod.default ?? mod)) as Plugin
}
const htmlPlugin = asPlugin(htmlPluginNs)
const cssPlugin = asPlugin(cssPluginNs)

export async function prettifyTemplateHtml(html: string): Promise<string> {
  if (!html.trim()) return html
  try {
    const pretty = await format(html, {
      parser: 'html',
      plugins: [htmlPlugin, cssPlugin],
      printWidth: 110,
      htmlWhitespaceSensitivity: 'css',
    })
    return pretty.trimEnd()
  } catch (e) {
    console.error('[pdf-templates] prettify failed; storing unformatted source:', e)
    return html
  }
}
