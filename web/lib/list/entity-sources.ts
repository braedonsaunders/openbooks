import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import type { ListViewConfig } from '@openbooks/customization'
import {
  PROJECT_BASE_JOINS,
  PROJECT_BUILT_IN_EXPR,
  PROJECT_SORTS,
  projectWhere,
  type EntityAdhoc,
} from '../customization/entity-list-query'

/**
 * Entity-list data sources — the SQL half of the universal list for plain
 * (non-`documents`) tables such as `projects`. Parallels lib/list/sources.ts
 * (documents-backed). components/entity-list-view.tsx renders any of these with
 * the same toolbar/table/view machinery; this registry is the ONLY place their
 * queries differ: which table/alias, joins, built-in column expressions, sort
 * expressions, where builder, and drill-through target.
 */
export interface EntityListSource {
  /** Customization record type key (must exist in RECORD_TYPES, category entity). */
  recordType: string
  /** Backing table and its alias. */
  table: string
  alias: string
  /** Table whose custom_field_defs + `custom` jsonb back this list's cf_ columns. */
  customFieldTable: string
  /** FROM joins after `<table> <alias>`. */
  baseJoins: SQL
  /** Built-in column key → SELECT expression. */
  builtInExpr: Record<string, SQL>
  /** Sort key → ORDER BY expression. */
  sorts: Record<string, SQL>
  /** Fallback ORDER BY when the requested sort key isn't in `sorts`. */
  defaultSort: SQL
  /** WHERE builder. */
  where: (
    view: ListViewConfig,
    adhoc: EntityAdhoc,
    orgId: string,
    allowedSubsidiaryIds?: Set<string> | null,
  ) => SQL
  /** URL param the actions cell toggles to open the edit drawer: /base?<param>=<id>. */
  drawerParam: string
  /** Base path for row links / drawer. */
  basePath: string
  /** Where the reference column links (default: the edit drawer). Projects link
   *  to the full cockpit page instead. */
  /** The list has an `is_active` flag → show a "show inactive" toggle. */
  hasInactive?: boolean
  /** Always-selected extra fields (e.g. is_active for row styling). */
  extraSelect?: SQL
}

const SOURCES: Record<string, EntityListSource> = {
  project: {
    recordType: 'project',
    table: 'projects',
    alias: 'p',
    customFieldTable: 'projects',
    baseJoins: PROJECT_BASE_JOINS,
    builtInExpr: PROJECT_BUILT_IN_EXPR,
    sorts: PROJECT_SORTS,
    defaultSort: sql`p.name`,
    where: projectWhere,
    drawerParam: 'project',
    basePath: '/projects',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
  },
}

export function entityListSource(recordType: string): EntityListSource | undefined {
  return SOURCES[recordType]
}
