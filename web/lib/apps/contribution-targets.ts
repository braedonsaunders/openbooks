import 'server-only'
import { PAGE_REGISTRY } from '../page-registry'
import type { ExtensionContribution } from './contributions'

/** Keep page loaders on the server; the shared manifest schema is client-safe. */
export function extensionContributionTargetErrors(contributions: readonly ExtensionContribution[]): string[] {
  return contributions.flatMap(item => item.kind === 'page' && !PAGE_REGISTRY[item.route]
    ? [`Page contribution must name an existing registered route: ${item.route}`] : [])
}
