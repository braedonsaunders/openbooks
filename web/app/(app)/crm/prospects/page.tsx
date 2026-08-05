import { AccountList } from '../AccountList'
export const dynamic = 'force-dynamic'
export default function Prospects({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) { return <AccountList stage="prospect" searchParams={searchParams} /> }
