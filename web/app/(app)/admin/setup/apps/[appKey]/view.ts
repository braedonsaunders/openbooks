import 'server-only'

import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import { loadSetupEntity, setupEntitySpec, type SetupEntityData } from '../../[entity]/view'

/**
 * Setup → App settings → one installed app. The settings an app declares use
 * the shared setup list and drawer, narrowed to that app; an app that is not
 * installed or declares no settings has no page.
 */
export async function loadAppSettings(
  appKey: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<SetupEntityData> {
  return loadSetupEntity('extension-settings', sp, { appKey })
}

export function appSettingsSpec(data: SetupEntityData): PageSpec {
  return { ...setupEntitySpec(data), route: '/admin/setup/apps/[appKey]' }
}
