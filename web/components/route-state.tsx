import { EmptyState, PageHeader } from '@openbooks/ui'
import { Clock3, GitBranch, SlidersHorizontal, Zap } from 'lucide-react'
import { ListPageLayout } from './page-layout'
import styles from './route-state.module.css'
import { NavigationRefusalSettled } from './page-pending'

/** House route-boundary chrome for authenticated app error and not-found surfaces. */
export function RouteStateView({
  icon,
  title,
  description,
  action,
  state,
  footer,
  presentation = 'standard',
  label,
  secondaryAction,
  placement = 'route',
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  /** Optional line under the action (the error boundary quotes its request id here). */
  footer?: React.ReactNode
  /** Full-canvas treatment for feature availability inside the app shell. */
  presentation?: 'standard' | 'feature'
  label?: string
  secondaryAction?: React.ReactNode
  /**
   * Where the feature canvas sits. `route` owns the whole page: its heading is
   * the page title. `section` fills a page body under the host's own header,
   * so the heading steps down a level and the browser tab keeps the page's
   * title.
   */
  placement?: 'route' | 'section'
  /**
   * Machine-readable name for WHY this boundary is showing.
   *
   * The e2e route sweep needs to tell a page that rendered from a page that
   * crashed into this boundary, and both answer HTTP 200 with text in
   * `<main>`. Matching the visible copy would work today and break the first
   * time someone runs the suite in another locale, so the signal is an
   * attribute rather than a sentence. `forbidden` (permission refused) and
   * `feature-disabled` (existing route, switch off) keep those two honest
   * refusals distinct from a genuine `not-found`.
   */
  state?: 'error' | 'not-found' | 'forbidden' | 'feature-disabled'
}) {
  if (presentation === 'feature') {
    const section = placement === 'section'
    return (
      <div
        className={section ? `${styles.canvas} ${styles.section}` : styles.canvas}
        data-route-state={state}
        data-route-presentation="feature"
        data-route-placement={placement}
      >
        {section ? null : <NavigationRefusalSettled />}
        <div className={styles.backdrop} aria-hidden="true" />
        <div className={styles.scroll}>
          <div className={styles.content}>
            <div className={styles.illustration} aria-hidden="true">
              <div className={styles.orbit} />
              <div className={styles.innerOrbit} />
              <svg className={styles.connections} viewBox="0 0 440 260" fill="none">
                <path d="M80 80H150Q170 80 170 100V110Q170 130 190 130H220M360 80H290Q270 80 270 100V110Q270 130 250 130H220M100 200H150Q170 200 170 180V150Q170 130 190 130H220M340 200H290Q270 200 270 180V150Q270 130 250 130H220" />
              </svg>
              <div className={`${styles.node} ${styles.nodeOne}`}><Clock3 /></div>
              <div className={`${styles.node} ${styles.nodeTwo}`}><SlidersHorizontal /></div>
              <div className={`${styles.node} ${styles.nodeThree}`}><GitBranch /></div>
              <div className={`${styles.node} ${styles.nodeFour}`}><Zap /></div>
              <div className={styles.icon}>{icon}</div>
              <span className={`${styles.spark} ${styles.sparkOne}`} />
              <span className={`${styles.spark} ${styles.sparkTwo}`} />
              <span className={`${styles.spark} ${styles.sparkThree}`} />
            </div>
            {label ? <div className={styles.label}>{label}</div> : null}
            {section ? (
              <div className={styles.heading}>
                <h2>{title}</h2>
                {description ? <p>{description}</p> : null}
              </div>
            ) : (
              <PageHeader title={title} description={description} className={styles.heading} />
            )}
            <div className={styles.actions}>{action}{secondaryAction}</div>
            {footer ? <p className={styles.footer}>{footer}</p> : null}
          </div>
        </div>
      </div>
    )
  }
  // One heading + one message: the PageHeader owns the copy; the body keeps
  // icon + recovery action so the boundary never reads twice.
  return (
    <ListPageLayout header={<PageHeader title={title} description={description} />}>
      <NavigationRefusalSettled />
      <div data-route-state={state}>
        <EmptyState icon={icon} action={action} />
        {footer ? (
          <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">{footer}</p>
        ) : null}
      </div>
    </ListPageLayout>
  )
}

/** Same chrome for routes outside the authenticated app shell (login, public links). */
export function RouteStateStandalone({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-screen-2xl flex-col p-4 sm:p-6">
      <PageHeader title={title} description={description} className="mb-8" />
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-lg">
          <EmptyState icon={icon} action={action} />
        </div>
      </div>
    </div>
  )
}
