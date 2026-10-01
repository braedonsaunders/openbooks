import 'server-only'
import type { Authz } from '../../lib/authz'
import type { ModuleHomeTab } from './tab-types'

export type TabGroup = 'customers' | 'purchasing' | 'banking' | 'accounting' | 'payroll' | 'hrm' | 'warehouse' | 'nonprofit' | 'resourcing'

/**
 * Compatibility for stored page specifications. Local navigation is resolved
 * once by the application layout and placed by the shared page layouts.
 * Page loaders no longer assemble a second workspace menu in header actions.
 */
export async function groupTabs(
  _group: TabGroup,
  _activeHref: string,
  _opts: { subQs?: string; exclude?: string[]; orgId: string },
): Promise<ModuleHomeTab[]> {
  return []
}

export async function customerGroupTabs(_authz: Authz, _activeHref: string, _opts: { subQs?: string } = {}): Promise<ModuleHomeTab[]> { return [] }
export async function hrmGroupTabs(_authz: Authz, _activeHref: string, _opts: { subQs?: string } = {}): Promise<ModuleHomeTab[]> { return [] }
export async function warehouseGroupTabs(_authz: Authz, _activeHref: string, _opts: { subQs?: string } = {}): Promise<ModuleHomeTab[]> { return [] }
export async function nonprofitGroupTabs(_authz: Authz, _activeHref: string, _opts: { subQs?: string } = {}): Promise<ModuleHomeTab[]> { return [] }
