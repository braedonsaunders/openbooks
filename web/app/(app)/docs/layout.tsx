import { DocsSidebar } from '../../../components/docs/docs-sidebar'
import { docNavIndex } from '../../../lib/docs'

// Documentation center — a source platform-help-style two-pane reader available to
// every signed-in user (linked from Administration). The left pane is the
// searchable category/article tree; the right pane is the scrolling content.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const { categories, sections, articles } = docNavIndex()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <DocsSidebar categories={categories} sections={sections} articles={articles} />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
