import { PagePending } from '../../components/page-pending'

// Page feedback occupies the content pane and ends as soon as content arrives.
// The shell remains available; the first-document splash has its own lifetime.
export default function AppLoading() {
  return <PagePending />
}
