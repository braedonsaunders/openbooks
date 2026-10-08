import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { migrationWorkspaceData, type MigrationWorkspaceData } from '../view'

/** One deep-linkable migration conversation: the workspace loader with an owned conversation. */
export function loadMigrationConversation(id: string): Promise<MigrationWorkspaceData> {
  return migrationWorkspaceData(id)
}

export function migrationConversationSpec(data: MigrationWorkspaceData): PageSpec {
  return page({
    route: '/migrate/[id]',
    layout: 'bare',
    header: [],
    body: [widgetBlock('migration-workspace', { ...data })],
  })
}
