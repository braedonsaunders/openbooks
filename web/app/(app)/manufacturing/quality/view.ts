import 'server-only'
import { column, link, page, pageHeader, ref, text, widget, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import type { ListToolbarFilter } from '@/components/list-toolbar'
import type { ModuleHomeTab } from '@/components/module-home/tab-types'
import { registeredListTable } from '@/lib/list/prepared-spec'

export type ManufacturingQualityRow = {
  id: string
  name: string
  itemName: string
  outcome: string
  quantity: string
  lotNumber: string
  serialNumber: string
  disposition: string
  href: string
}

export type ManufacturingQualityData = {
  title: string
  description: string
  plansLabel: string
  plansHref: string
  canManagePlans: boolean
  tabs: ModuleHomeTab[]
  currentParams: Record<string, string | string[] | undefined>
  basePath: string
  filters: ListToolbarFilter[]
  searchPlaceholder: string
  queue: { rows: ManufacturingQualityRow[]; total: number; page: number; perPage: number }
  emptyTitle: string
  emptyDescription: string
  columns: { name: string; item: string; outcome: string; quantity: string; lot: string; serial: string; disposition: string }
}

const f = ref<ManufacturingQualityData>()
const row = ref<ManufacturingQualityRow>()

export function manufacturingQualitySpec(_data: ManufacturingQualityData): PageSpec {
  return page({
    route: '/manufacturing/quality',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-2',
        actions: [
          widget('module-home-tabs', { tabs: f('tabs') }),
          widget('link-button', {
            href: f('plansHref'),
            label: f('plansLabel'),
            variant: 'outline',
          }, f('canManagePlans')),
        ],
      }),
    ],
    body: [
      registeredListTable('manufacturing_quality', {
        variant: 'app',
        rows: f('queue.rows'),
        rowKey: row('id'),
        empty: { title: f('emptyTitle'), description: f('emptyDescription') },
        columns: [
          column(f('columns.name'), link(row('name'), row('href')), { className: 'font-medium' }),
          column(f('columns.item'), text(row('itemName'))),
          column(f('columns.outcome'), text(row('outcome'))),
          column(f('columns.quantity'), text(row('quantity'))),
          column(f('columns.lot'), text(row('lotNumber'))),
          column(f('columns.serial'), text(row('serialNumber'))),
          column(f('columns.disposition'), text(row('disposition'))),
        ],
      }, [widget('list-toolbar', {
        basePath: f('basePath'),
        currentParams: f('currentParams'),
        search: { placeholder: f('searchPlaceholder') },
        filters: f('filters'),
      })]),
    ],
  })
}
