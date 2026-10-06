import 'server-only'
import { can, type Authz } from '../authz'
import { featureEnabled, type FeatureState } from '../features'
import { SETUP_ENTITIES, resolveSetupEntityGate } from './registry'
import type { SetupRailFlags } from './rail'

/**
 * The reader's Setup rail flags: permissions and Features switches, resolved
 * once. The Setup workspace renders its rail from these and global search
 * offers the same Setup pages, so both answer from one decision.
 */
export function setupRailFlags(authz: Authz, features: FeatureState): SetupRailFlags {
  return {
    canExport: can(authz, 'data.export'),
    canImport: can(authz, 'data.import'),
    canManageSetup: can(authz, 'admin.setup.manage'),
    canReadPayrollPackages: can(authz, 'payroll.read') && featureEnabled(features, 'payroll'),
    canManagePerformance: can(authz, 'hrm.performance.manage') && featureEnabled(features, 'hrm') && featureEnabled(features, 'hrmPerformance'),
    canManageCompensation: can(authz, 'hrm.compensation.manage') && authz.allowedSubsidiaryIds === null && featureEnabled(features, 'hrmCompensation'),
    canManageCrm: can(authz, 'crm.setup.manage'),
    canManagePeriods: can(authz, 'periods.manage'),
    // One authoritative gate hides rail tabs — never a local OR over featureKey.
    hiddenEntityKeys: SETUP_ENTITIES.filter((entity) => !resolveSetupEntityGate(entity, features).enabled).map((entity) => entity.key),
    projectsEnabled: featureEnabled(features, 'projects'),
    currencyEnabled: featureEnabled(features, 'multiCurrency'),
    fixedAssetsEnabled: featureEnabled(features, 'fixedAssets'),
    crmEnabled: featureEnabled(features, 'crm'),
    bankFeedsEnabled: featureEnabled(features, 'bankFeeds'),
    onlinePaymentsEnabled: featureEnabled(features, 'onlinePayments'),
    shippingEnabled: featureEnabled(features, 'shippingHub'),
    payrollEnabled: featureEnabled(features, 'payroll'),
    hrmEnabled: featureEnabled(features, 'hrm'),
  }
}
