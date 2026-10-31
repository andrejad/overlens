import { useEffect, useState } from 'react'
import { auditCsvUrl, fetchAudit } from '../../api/resources'
import type { AuditEntry, AuditFilters } from '../../api/types'
import { fmtTime } from '../../lib/apiError'
import { BTN, BTN_PRIMARY, INPUT } from '../../lib/ui'

const PAGE = 25

const FIELDS: { key: keyof AuditFilters; label: string; type?: string }[] = [
  { key: 'user', label: 'User' },
  { key: 'action', label: 'Action' },
  { key: 'type', label: 'Type' },
  { key: 'team', label: 'Team' },
  { key: 'deliverable', label: 'Roadmap item' },
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
]

function detailsText(d: unknown): string {
  if (d == null) return ''
  return typeof d === 'string' ? d : JSON.stringify(d)
}

// REQ_AUD_016 filters and CSV, REQ_AUD_008 retention badge and notice (word for word). The CSV link carries
// the applied filters, never paging.
export function AuditCard() {
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [draft, setDraft] = useState<AuditFilters>({})
  const [applied, setApplied] = useState<AuditFilters>({})
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<AuditEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setError('')
    void fetchAudit(applied, PAGE, offset)
      .then((r) => {
        if (cancelled) return
        setRows(r.items)
        setTotal(r.total)
        setRetentionDays(r.retention_days)
      })
      .catch(() => !cancelled && setError('Could not load the audit log.'))
    return () => {
      cancelled = true
    }
  }, [applied, offset])

  function apply() {
    setOffset(0)
    setApplied({ ...draft })
  }

  const first = total === 0 ? 0 : offset + 1
  const last = Math.min(offset + PAGE, total)
  return (
    <section className="bg-surface border border-border rounded-lg p-4" id="admin-audit" aria-labelledby="admin-audit-h">
      <div className="flex items-center gap-3 mb-1">
        <h2 id="admin-audit-h" className="font-semibold text-lg flex-1">
          Audit log
        </h2>
        <span className="text-xs border border-border rounded px-2 py-0.5" data-testid="retention-badge">
          Retention {retentionDays ?? '…'} days
        </span>
      </div>
      <p className="text-sm text-text-2 mb-1">
        Every change is recorded. Rows older than the retention period are deleted automatically.
      </p>
      <p className="text-xs text-text-3 mb-3" data-testid="audit-notice">
        Set by <code>audit_retention_days</code> in <code>overlens.conf</code> (default 365), not editable here. Older rows are
        removed automatically; nobody can delete entries by hand.
      </p>
      <form
        className="flex items-end gap-2 flex-wrap mb-3"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        {FIELDS.map((f) => (
          <label key={f.key} className="text-xs text-text-2 flex flex-col gap-1">
            {f.label}
            <input
              className={`${INPUT} ${f.type === 'date' ? 'w-auto' : 'w-32'}`}
              type={f.type ?? 'text'}
              value={draft[f.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <button type="submit" className={BTN_PRIMARY}>
          Apply filters
        </button>
        <a className={BTN} href={auditCsvUrl(applied)} download data-testid="audit-csv">
          Export CSV
        </a>
      </form>
      {error && (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="text-text-2 text-sm">Loading…</p>}
      {rows && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-2 text-xs">
              <th className="py-1">Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Type</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="py-1 whitespace-nowrap">{fmtTime(r.ts)}</td>
                <td>{r.username}</td>
                <td>{r.action}</td>
                <td>{r.entity_type}</td>
                <td className="text-text-2 break-all">{detailsText(r.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-2 mt-2 text-xs text-text-3">
        <span className="flex-1">
          Names are stored on each entry, so it stays readable after a rename or delete. · Showing {first}–{last} of {total}
        </span>
        <button type="button" className={BTN} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Prev
        </button>
        <button type="button" className={BTN} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          Next
        </button>
      </div>
    </section>
  )
}
