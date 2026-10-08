import { CORE_WIDGETS } from './widgets-core'
import { PAYROLL_WIDGETS } from './widgets-payroll'
import { BANKING_WIDGETS } from './widgets-banking'
import { REPORTING_WIDGETS } from './widgets-reporting'
import { ASSETS_TAX_WIDGETS } from './widgets-assets-tax'
import { COMMERCE_WIDGETS } from './widgets-commerce'
import { PLATFORM_WIDGETS } from './widgets-platform'
import { SETUP_WIDGETS } from './widgets-setup'
import { AGENTS_WIDGETS } from './widgets-agents'
import { HOME_WIDGETS } from './widgets-home'
import { HRM_WIDGETS } from './widgets-hrm'
import { HRM_CONTINUOUS_WIDGETS } from './widgets-hrm-continuous'
import { HRM_DOCUMENT_WIDGETS } from './widgets-hrm-documents'
import { HRM_PROCESS_WIDGETS } from './widgets-hrm-processes'
import { HRM_FIELD_TIME_WIDGETS } from './widgets-hrm-field-time'
import { PERSONA_WIDGETS } from './widgets-home-persona'
import { OPERATIONS_WIDGETS } from './widgets-operations'
import { RECORDS_WIDGETS } from './widgets-records'
import { CONTROLS_WIDGETS } from './widgets-controls'
import { WAREHOUSE_WIDGETS } from './widgets-warehouse'
import { NONPROFIT_WIDGETS } from './widgets-nonprofit'
import { RESOURCING_BOARD_WIDGETS } from './widgets-resourcing-board'
import { RESOURCING_DEMAND_WIDGETS } from './widgets-resourcing-demand'
import { RESOURCING_REQUEST_WIDGETS } from './widgets-resourcing-requests'
import { RESOURCING_RETAINER_WIDGETS } from './widgets-resourcing-retainers'
import { RESOURCING_COCKPIT_WIDGETS } from './widgets-resourcing-cockpit'
import type { WidgetRenderer } from './widget-props'

/**
 * Widget registry — the closed set of interactive components a spec may place
 * into a slot.
 *
 * Native pages pass arbitrary JSX into slots like the filter bar's `actions`.
 * A spec cannot express JSX, so it names a widget instead and the host
 * resolves the name. Keeping the registry closed is a security property, not
 * a convenience: a spec that could name any component would be able to mount
 * anything the bundle contains, which is exactly the escape hatch the
 * block-vocabulary design exists to prevent.
 *
 * Placing a widget grants no capability. Each widget re-checks permission on
 * the host side exactly as it does when a native page renders it, so a spec
 * author who lacks a permission gets the same empty result a user would.
 *
 * This module is the complete composition, read by the contract generator and
 * the registry tests. Rendering never imports it: `widget-loader.ts` resolves
 * a name through `widget-index.ts` and loads only the family that defines it.
 */
export const WIDGET_REGISTRY: Record<string, WidgetRenderer> = {
  ...CORE_WIDGETS,
  ...PAYROLL_WIDGETS,
  ...BANKING_WIDGETS,
  ...REPORTING_WIDGETS,
  ...ASSETS_TAX_WIDGETS,
  ...COMMERCE_WIDGETS,
  ...PLATFORM_WIDGETS,
  ...SETUP_WIDGETS,
  ...AGENTS_WIDGETS,
  ...HOME_WIDGETS,
  ...HRM_WIDGETS,
  ...HRM_CONTINUOUS_WIDGETS,
  ...HRM_DOCUMENT_WIDGETS,
  ...HRM_PROCESS_WIDGETS,
  ...HRM_FIELD_TIME_WIDGETS,
  ...PERSONA_WIDGETS,
  ...OPERATIONS_WIDGETS,
  ...RECORDS_WIDGETS,
  ...NONPROFIT_WIDGETS,
  ...CONTROLS_WIDGETS,
  ...WAREHOUSE_WIDGETS,
  ...RESOURCING_BOARD_WIDGETS,
  ...RESOURCING_DEMAND_WIDGETS,
  ...RESOURCING_REQUEST_WIDGETS,
  ...RESOURCING_RETAINER_WIDGETS,
  ...RESOURCING_COCKPIT_WIDGETS,
}
