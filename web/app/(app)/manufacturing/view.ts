import 'server-only'
import {
  column,
  grid,
  link,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import type { DirectoryItem } from '@/components/module-home/ui'
import type { ListToolbarFilter } from '@/components/list-toolbar'
import type { ModuleHomeTab } from '@/components/module-home/tab-types'
import { registeredListTable } from '@/lib/list/prepared-spec'

export type ManufacturingHomeRow = {
  id: string
  number: string
  itemName: string
  statusLabel: string
  quantityCompleted: string
  quantityOrdered: string
  unit: string
  href: string
}

export type ManufacturingHomeData = {
  title: string
  description: string
  labels: {
    open: string
    inProgress: string
    pendingQuality: string
    attention: string
    completedSevenDays: string
    hero: string
    directory: string
    attentionTitle: string
    allClear: string
    newWorkOrder: string
    search: string
  }
  columns: { number: string; item: string; status: string; finished: string; ordered: string }
  metrics: {
    openWorkOrders: string
    inProgressWorkOrders: string
    pendingInspections: string
    pastDueOrOnHoldWorkOrders: string
    completedLastSevenDays: string
  }
  orders: { rows: ManufacturingHomeRow[]; total: number; page: number; perPage: number }
  tabs: ModuleHomeTab[]
  subsidiaryPicker: { id: string; label: string }[]
  subsidiaryId: string
  subsidiaryLabel: string
  canCreate: boolean
  newWorkOrderHref: string
  currentParams: Record<string, string | string[] | undefined>
  filters: ListToolbarFilter[]
  directory: DirectoryItem[]
  attention: { tone: 'negative' | 'warning'; text: string; href: string }[]
}

const f = ref<ManufacturingHomeData>()
const row = ref<ManufacturingHomeRow>()

export function manufacturingHomeSpec(data: ManufacturingHomeData): PageSpec {
  return page({
    route: '/manufacturing',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-2',
        actions: [
          widget('subsidiary-switcher', {
            picker: f('subsidiaryPicker'),
            value: f('subsidiaryId'),
            label: f('subsidiaryLabel'),
          }),
          widget('module-home-tabs', { tabs: f('tabs') }),
          widget('link-button', {
            href: f('newWorkOrderHref'),
            label: f('labels.newWorkOrder'),
            iconKey: 'plus',
          }, f('canCreate')),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({ iconKey: 'clipboard', accent: 'teal', label: f('labels.open'), value: f('metrics.openWorkOrders') }),
          statTile({ iconKey: 'timer', accent: 'sky', label: f('labels.inProgress'), value: f('metrics.inProgressWorkOrders') }),
          statTile({ iconKey: 'shield-check', accent: 'amber', label: f('labels.pendingQuality'), value: f('metrics.pendingInspections') }),
          statTile({ iconKey: 'triangle-alert', accent: 'red', label: f('labels.attention'), value: f('metrics.pastDueOrOnHoldWorkOrders'), tone: 'negative' }),
          statTile({ iconKey: 'check-circle', accent: 'emerald', label: f('labels.completedSevenDays'), value: f('metrics.completedLastSevenDays'), tone: 'positive' }),
        ]),
        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('labels.hero'),
            iconKey: 'clipboard',
            className: 'min-h-0 lg:col-span-2',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              registeredListTable('manufacturing_home_queue', {
                variant: 'app',
                rows: f('orders.rows'),
                rowKey: row('id'),
                empty: { title: f('labels.hero'), description: f('description') },
                columns: [
                  column(f('columns.number'), link(row('number'), row('href')), { className: 'font-medium' }),
                  column(f('columns.item'), text(row('itemName'))),
                  column(f('columns.status'), text(row('statusLabel'))),
                  column(f('columns.finished'), text(row('quantityCompleted'))),
                  column(f('columns.ordered'), text(row('quantityOrdered'))),
                ],
              }, [widget('list-toolbar', {
                basePath: '/manufacturing',
                currentParams: f('currentParams'),
                search: { placeholder: f('labels.search') },
                filters: f('filters'),
              })]),
            ],
          }),
          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            widgetBlock('directory-section', { items: f('directory'), title: f('labels.directory') }),
            panel({
              title: f('labels.attentionTitle'),
              iconKey: 'alert',
              className: 'shrink-0',
              bodyClassName: 'p-0',
              blocks: [widgetBlock('attention-list', { items: f('attention'), allClear: f('labels.allClear') })],
            }),
          ]),
        ]),
      ]),
    ],
  })
}
