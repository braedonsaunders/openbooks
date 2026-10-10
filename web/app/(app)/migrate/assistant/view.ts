import 'server-only'

import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import { migrationWorkspaceData, migrationWorkspaceSpec, type MigrationWorkspaceData } from '../view'

/** A new migration assistant conversation: the optional helper beside the guided cutover. */
export function loadMigrationAssistant(sp: Record<string, string | string[] | undefined> = {}): Promise<MigrationWorkspaceData> {
  return migrationWorkspaceData(null, sp)
}

export function migrationAssistantSpec(data: MigrationWorkspaceData): PageSpec {
  return migrationWorkspaceSpec('/migrate/assistant', data)
}
