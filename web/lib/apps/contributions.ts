import { z } from 'zod'
import { pageSpecSchema, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { supplementalContributionSchema } from '@openbooks/engine/src/extensions/contribution-schemas.ts'
import { validateAgainstRegistries } from '../page-spec-validate'
import { WIDGET_NAMES, FRAME_NAMES } from '../../components/viewspec/registry-names'
import { WIDGET_CONTRACTS } from '../../components/viewspec/widget-contracts'

const pageContribution = z.object({
  kind: z.literal('page'), route: z.string().min(1).max(120),
  scope: z.literal('org').default('org'), spec: pageSpecSchema.transform(value => value as PageSpec),
}).strict()

/** Only implemented projections belong in the extension contract. Record types
 * and fields use objects/*.json; backend endpoints use manifest.endpoints. */
export const extensionContributionsSchema = z.array(z.union([pageContribution, supplementalContributionSchema])).max(200).superRefine((items, ctx) => {
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    const identity = `${item.kind}:${item.kind === 'page' ? item.route : item.kind === 'nav' ? item.href : item.key}`
    if (seen.has(identity)) ctx.addIssue({ code: 'custom', path: [index], message: `Duplicate contribution ${identity}` })
    seen.add(identity)
    if (item.kind === 'page') {
      if (item.spec.route && item.spec.route !== item.route) ctx.addIssue({ code: 'custom', path: [index, 'spec'], message: 'Page route does not match its contribution' })
      const result = validateAgainstRegistries(item.spec, { widgets: new Set(WIDGET_NAMES), frames: new Set(FRAME_NAMES), contracts: WIDGET_CONTRACTS })
      if (!result.ok) for (const message of result.errors) ctx.addIssue({ code: 'custom', path: [index, 'spec'], message })
    }
  }
})
export type ExtensionContribution = z.infer<typeof extensionContributionsSchema>[number]
export const EXTENSION_CONTRIBUTION_PERMISSIONS = {
  page: 'admin.customization.manage', nav: 'admin.customization.manage', setting: 'admin.setup.manage', permission: 'admin.roles.manage',
} as const
