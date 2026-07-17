'use client'

import { DocumentDrawer } from './document-drawer'
import { PaymentDrawer } from '../app/(app)/payments/PaymentDrawer'
import { OrderDrawer } from '../app/(app)/_order/OrderDrawer'
import { ExpenseDrawer } from '../app/(app)/expenses/ExpenseDrawer'
import { JournalDrawer } from '../app/(app)/journal/JournalDrawer'

export type RelatedTransactionDrawerData =
  | { type: 'document'; props: Parameters<typeof DocumentDrawer>[0] }
  | { type: 'payment'; props: Parameters<typeof PaymentDrawer>[0] }
  | { type: 'order'; props: Parameters<typeof OrderDrawer>[0] }
  | { type: 'expense'; props: Parameters<typeof ExpenseDrawer>[0] }
  | { type: 'journal'; props: Parameters<typeof JournalDrawer>[0] }

export function RelatedTransactionDrawerClient({ data }: { data: RelatedTransactionDrawerData }) {
  if (data.type === 'document') return <DocumentDrawer {...data.props} />
  if (data.type === 'payment') return <PaymentDrawer {...data.props} />
  if (data.type === 'order') return <OrderDrawer {...data.props} />
  if (data.type === 'expense') return <ExpenseDrawer {...data.props} />
  return <JournalDrawer {...data.props} />
}
