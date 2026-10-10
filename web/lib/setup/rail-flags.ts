import 'server-only'
import { can, type Authz } from '../authz'
import { featureEnabled, type FeatureState } from '../features'
import { SETUP_ENTITIES, resolveSetupEntityGate } from './registry'
import { listAppSettingPages } from './extension-settings'
import type { SetupRailFlags } from './rail'

/**
 * The reader's Setup rail flags: permissions and Features switches, resolved
 * once. The Setup workspace renders its rail from these and global search
 * offers the same Setup pages, so both answer from one decision.
 */
export async function setupRailFlags(authz: Authz, features: FeatureState): Promise<SetupRailFlags> {
  const canManageSetup = can(authz, 'admin.setup.manage')
  // App settings are organization-wide, so subsidiary-scoped administrators
  // have no app settings pages to open.
  const appSettings = canManageSetup && authz.allowedSubsidiaryIds === null && featureEnabled(features, 'apps')
    ? await listAppSettingPages(authz.user.orgId)
    : []
  return {
    canExport: can(authz, 'data.export'),
    canImport: can(authz, 'data.import'),
    canManageSetup,
    canReadPayrollPackages: can(authz, 'payroll.read') && featureEnabled(features, 'payroll'),
    canManagePerformance: can(authz, 'hrm.performance.manage') && featureEnabled(features, 'hrm') && featureEnabled(features, 'hrmPerformance'),
    canManageCompensation: can(authz, 'hrm.compensation.manage') && authz.allowedSubsidiaryIds === null && featureEnabled(features, 'hrmCompensation'),
    canManageCrm: can(authz, 'crm.setup.manage'),
    canManagePeriods: can(authz, 'periods.manage'),
    // One authoritative gate hides rail tabs — never a local OR over featureKey.
    hiddenEntityKeys: SETUP_ENTITIES.filter((entity) => !resolveSetupEntityGate(entity, features).enabled).map((entity) => entity.key),
    projectsEnabled: featureEnabled(features, 'projects'),
    manufacturingEnabled: featureEnabled(features, 'manufacturing') && authz.allowedSubsidiaryIds === null,
    currencyEnabled: featureEnabled(features, 'multiCurrency'),
    fixedAssetsEnabled: featureEnabled(features, 'fixedAssets'),
    crmEnabled: featureEnabled(features, 'crm'),
    bankFeedsEnabled: featureEnabled(features, 'bankFeeds'),
    onlinePaymentsEnabled: featureEnabled(features, 'onlinePayments'),
    shippingEnabled: featureEnabled(features, 'shippingHub'),
    payrollEnabled: featureEnabled(features, 'payroll'),
    hrmEnabled: featureEnabled(features, 'hrm'),
    appSettings,
  }
}
