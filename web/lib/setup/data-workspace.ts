import { permissionSetCovers } from '../permissions'

/** Data tools share Setup navigation when the operator can open its tabs. */
export function dataWorkspaceNavigation(permissions: Set<string>) {
  if (permissionSetCovers(permissions, 'admin.setup.manage')) {
    return { showSetup: true, backHref: '/admin/setup/company', backLabelKey: 'admin.setup.entities.company.title' }
  }
  if (permissionSetCovers(permissions, 'crm.setup.manage')) {
    return { showSetup: true, backHref: '/admin/setup/crm', backLabelKey: 'crm.setup.title' }
  }
  return { showSetup: false, backHref: '/', backLabelKey: 'nav.modules.dashboard' }
}
