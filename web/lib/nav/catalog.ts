import 'server-only'
import { getTranslations } from 'next-intl/server'
import { LOCAL_NAVIGATION } from '@openbooks/engine/navigation'
import { listActiveExtensionContributions } from '@openbooks/engine/extensions/navigation'
import { nativeAppNavigationCatalog } from './native-apps'

export type NavigationEditorWorkspace = { id: string; label: string; tabs: { href: string; label: string }[] }

/** The editor sees registered choices, including active extension pages. */
export async function navigationEditorCatalog(orgId: string): Promise<NavigationEditorWorkspace[]> {
  const namespaces = [...new Set(LOCAL_NAVIGATION.flatMap((set) => set.tabs.map((tab) => tab.ns)))]
  const [entries, translators] = await Promise.all([
    listActiveExtensionContributions(orgId),
    Promise.all(namespaces.map(async (namespace) => [namespace, await getTranslations(namespace as never)] as const)),
  ])
  const translations = new Map(translators)
  const tNav = await getTranslations('nav')
  const native = LOCAL_NAVIGATION.map((set) => ({
    id: set.id,
    label: tNav(`localWorkspaces.${set.id}` as never),
    tabs: [
      ...set.tabs.map((tab) => ({ href: tab.href, label: translations.get(tab.ns)!(tab.key as never) })),
      ...entries.flatMap((entry) => entry.contribution.kind === 'nav' && entry.contribution.workspaceKey === set.id ? [{ href: entry.contribution.href, label: entry.contribution.label }] : []),
    ],
  }))
  return [...native, ...await nativeAppNavigationCatalog(orgId)]
}
