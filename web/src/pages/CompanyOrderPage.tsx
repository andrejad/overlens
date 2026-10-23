import { useEffect, useRef, useState } from 'react'
import { TopBar } from '../components/AppChrome'
import { OrderList } from '../components/OrderList'
import { useCanEdit } from '../lib/canEdit'
import { apiError, sessionRefusal } from '../lib/apiError'
import { fetchCompanyRoadmaps, fetchWorkstreamOrder, putTeamOrder, putWorkstreamOrder } from '../api/resources'
import { mergeByWorkstreamName, norm } from '../timeline/company'

interface Row {
  key: string | number
  name: string
  tag?: string // a team's tag
}

// REQ_FE_116/117: the Company order page, "#/company/order". Two cards, always both and always in this order, each the
// Manage workstreams list (OrderList). Every change saves at once with the full list; anonymous visitors see both
// lists read-only.
export function CompanyOrderPage() {
  const canEdit = useCanEdit()
  const [data, setData] = useState<{ teams: Row[]; workstreams: Row[] } | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchCompanyRoadmaps(), fetchWorkstreamOrder()]).then(
      ([all, saved]) => {
        if (cancelled) return
        const teams = all.map((c) => ({ key: c.team.id, name: c.team.name, tag: c.team.tag }))
        // REQ_FE_117: the same full list a save sends: the saved names, then the names the saved order doesn't list,
        // alphabetically (as the company view shows them). Names no roadmap holds are not listed, so a
        // save drops their saved position (accepted, REQ_FE_117).
        const rowNames = mergeByWorkstreamName(all, saved).rows.map((r) => r.name)
        const names: string[] = []
        const seen = new Set<string>()
        for (const n of [...saved, ...rowNames]) {
          if (!seen.has(norm(n))) {
            seen.add(norm(n))
            names.push(n)
          }
        }
        const workstreams = names.map((n) => ({ key: n, name: n }))
        setData({ teams, workstreams })
      },
      (err) => {
        if (cancelled) return
        console.error('company.order_load_failed', { error: String(err) })
        setLoadError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const head = (
    <header>
      <div className="text-xs text-text-3">Company view</div>
      <h1 className="text-2xl font-semibold">Company order</h1>
      <a className="text-accent underline text-sm" href="#/company/workstreams" data-testid="back-to-company">
        Back to the company view
      </a>
    </header>
  )

  return (
    <>
      <TopBar variant="company" />
      <main className="p-6 flex flex-col gap-4 max-w-[760px]" data-testid="company-order">
        {head}
        {loadError ? (
          <p className="text-danger" role="alert">
            Could not load the company order.
          </p>
        ) : !data ? (
          <p className="text-text-2">Loading…</p>
        ) : (
          <>
            <OrderCard
              testId="team-order-card"
              title="Team order"
              hint="Drag to reorder. The team list shows the teams in this order."
              logName="team"
              initial={data.teams}
              canEdit={canEdit}
              save={(keys) => putTeamOrder(keys as number[])}
            />
            <OrderCard
              testId="workstream-order-card"
              title="Workstream order"
              hint="Drag to reorder. The company view lists the merged workstream rows in this order."
              logName="workstream"
              initial={data.workstreams}
              canEdit={canEdit}
              save={(keys) => putWorkstreamOrder(keys as string[])}
            />
          </>
        )}
      </main>
    </>
  )
}

function OrderCard({
  testId,
  title,
  hint,
  logName,
  initial,
  canEdit,
  save,
}: {
  testId: string
  title: string
  hint: string
  logName: 'team' | 'workstream'
  initial: Row[]
  canEdit: boolean
  save: (keys: (string | number)[]) => Promise<unknown>
}) {
  const [rows, setRows] = useState(initial)
  const [message, setMessage] = useState('')
  const saving = useRef(false)

  async function onMove(from: number, to: number) {
    if (saving.current) {
      return
    }
    const before = rows
    const next = before.slice()
    next.splice(to, 0, next.splice(from, 1)[0])
    saving.current = true
    setMessage('')
    setRows(next)
    try {
      await save(next.map((r) => r.key))
    } catch (err) {
      const e = apiError(err)
      console.error(`company.${logName}_order_failed`, { status: e.status, code: e.code })
      setRows(before)
      setMessage(sessionRefusal(err) || e.message || 'Could not save the order')
    } finally {
      saving.current = false
    }
  }

  return (
    <section className="border border-border rounded-lg bg-surface" data-testid={testId}>
      <header className="px-4 pt-3 pb-2 border-b border-border">
        <h2 className="font-semibold text-lg">{title}</h2>
        <p className="text-sm text-text-2">{hint}</p>
      </header>
      <div className="p-4">
        {message && (
          <div className="hint bad mb-2" role="alert" data-testid="order-message">
            {message}
          </div>
        )}
        <OrderList
          items={rows}
          getKey={(r) => r.key}
          label={(r) => r.name}
          canEdit={canEdit}
          testId={`${testId}-list`}
          onMove={(from, to) => void onMove(from, to)}
          renderMain={(r) => (
            <>
              <span className="nm" title={r.name}>
                {r.name}
              </span>
              {r.tag && <span className="ct">{r.tag}</span>}
            </>
          )}
        />
        {rows.length === 0 && <p className="text-text-2 text-sm">Nothing to order yet.</p>}
      </div>
    </section>
  )
}
