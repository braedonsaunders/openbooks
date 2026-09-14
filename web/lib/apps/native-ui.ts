import { z } from 'zod'
import { pageSpecSchema, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { validateAgainstRegistries } from '../page-spec-validate'

/** Native extension screens compose host layouts and governed custom-record workspaces.
 * No uploaded JS executes in the host origin, and no tenant-supplied widget can
 * obtain ambient server capabilities. Executable bundles retain the iframe path.
 */
const screenKey = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64)
export const nativeExtensionSchema = z.object({
  screens: z.array(z.discriminatedUnion('kind', [
    z.object({ key: screenKey, title: z.string().min(1).max(120), kind: z.literal('page'), spec: pageSpecSchema.transform(value => value as PageSpec) }).strict(),
    z.object({ key: screenKey, title: z.string().min(1).max(120), kind: z.literal('records'), typeKey: screenKey }).strict(),
  ])).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>()
  for (const [index, screen] of value.screens.entries()) {
    if (keys.has(screen.key)) ctx.addIssue({ code: 'custom', path: ['screens', index, 'key'], message: 'duplicate screen key' })
    keys.add(screen.key)
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

export function parseNativeExtension(content: string): NativeExtension {
  return nativeExtensionSchema.parse(JSON.parse(content))
}
