import 'server-only'

import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import { migrationWorkspaceData, migrationWorkspaceSpec, type MigrationWorkspaceData } from '../view'

/** One deep-linkable migration conversation: the workspace loader with an owned conversation. */
export function loadMigrationConversation(id: string): Promise<MigrationWorkspaceData> {
  return migrationWorkspaceData(id)
}

export function migrationConversationSpec(data: MigrationWorkspaceData): PageSpec {
  return migrationWorkspaceSpec('/migrate/[id]', data)
}
