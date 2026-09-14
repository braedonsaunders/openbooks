import { z } from 'zod'
import { pageSpecSchema, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { formSectionSchema } from '@openbooks/forms-core'
import { lintRecordFields } from '../record-schema'
import type { AppManifest } from './manifest'
import { validateAgainstRegistries } from '../page-spec-validate'

/** Native extension screens compose host layouts and governed custom-record workspaces.
 * No uploaded JS executes in the host origin, and no tenant-supplied widget can
 * obtain ambient server capabilities. Custom JavaScript frontends use the isolated sandbox renderer.
 */
const screenKey = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)
export const nativeExtensionSchema = z.object({
  screens: z.array(z.discriminatedUnion('kind', [
    z.object({ key: screenKey, title: z.string().min(1).max(120), kind: z.literal('page'), spec: pageSpecSchema.transform(value => value as PageSpec) }).strict(),
    z.object({ key: screenKey, title: z.string().min(1).max(120), kind: z.literal('records'), typeKey: screenKey }).strict(),
    z.object({ key: screenKey, title: z.string().min(1).max(120), kind: z.literal('action'), endpoint: screenKey, fields: z.array(formSectionSchema).max(50), submitLabel: z.string().min(1).max(120), description: z.string().max(2000).optional(), confirmation: z.string().min(1).max(1000).optional() }).strict(),
  ])).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>()
  for (const [index, screen] of value.screens.entries()) {
    if (keys.has(screen.key)) ctx.addIssue({ code: 'custom', path: ['screens', index, 'key'], message: 'duplicate screen key' })
    keys.add(screen.key)
    if (screen.kind === 'action') {
      const checked = lintRecordFields(screen.fields, screen.title)
      for (const issue of checked.issues) ctx.addIssue({ code: 'custom', path: ['screens', index, 'fields', ...issue.path], message: issue.message })
    }
    if (screen.kind === 'page') {
      const checked = validateAgainstRegistries(screen.spec, {
        widgets: new Set(['link-button']), frames: new Set(),
        contracts: { 'link-button': { props: ['href', 'label', 'variant', 'size', 'iconKey'] } },
      })
      if (!checked.ok) for (const message of checked.errors) ctx.addIssue({ code: 'custom', path: ['screens', index, 'spec'], message })
    }
  }
})
export type NativeExtension = z.infer<typeof nativeExtensionSchema>

export function parseNativeExtension(content: string, manifest?: AppManifest): NativeExtension {
  const ui = nativeExtensionSchema.parse(JSON.parse(content))
  if (manifest) for (const screen of ui.screens) {
    if (screen.kind === 'action' && !manifest.endpoints.some(endpoint => endpoint.name === screen.endpoint && endpoint.method !== 'GET')) {
      throw new Error(`Action "${screen.key}" requires a declared POST or ANY backend endpoint`)
    }
  }
  return ui
}
