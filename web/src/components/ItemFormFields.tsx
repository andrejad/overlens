import { useEffect, useRef, useState } from 'react'
import type { LinkInput, Status } from '../api/types'
import { trimName } from '../lib/ui'
import { STATUS } from '../lib/status'

// The status buttons, risk note and link rows shared by the deliverable and the milestone forms (REQ_FE_041, 121).
const STATUS_ORDER: Status[] = ['planned', 'in_progress', 'done', 'at_risk']
const STATUS_CLASS: Record<Status, string> = { planned: 'st-planned', in_progress: 'st-progress', done: 'st-done', at_risk: 'st-risk' }

export function StatusField({
  status,
  statusError,
  onPick,
  risk,
  riskError,
  onRiskChange,
  onRiskFocus,
  onRiskBlur,
}: {
  status: Status
  statusError: string
  onPick: (s: Status) => void
  risk: string
  riskError: string
  onRiskChange: (v: string) => void
  onRiskFocus: () => void
  onRiskBlur: () => void
}) {
  return (
    <div className="field">
      <label>Status</label>
      <div className={`segs${statusError ? ' bad' : ''}`} role="group" aria-label="Status">
        {STATUS_ORDER.map((value) => {
          const { label, Icon: StatusIcon } = STATUS[value]
          return (
            <button
              key={value}
              type="button"
              data-s={value}
              aria-pressed={status === value}
              className={`st-opt ${STATUS_CLASS[value]}${status === value ? ' on' : ''}`}
              onClick={() => onPick(value)}
            >
              <StatusIcon size={13} aria-hidden="true" /> {label}
            </button>
          )
        })}
      </div>
      {statusError && (
        <div className="hint bad" role="alert">
          {statusError}
        </div>
      )}
      {status === 'at_risk' && (
        <textarea
          className={`inp risk-note${riskError ? ' bad' : ''}`}
          rows={2}
          placeholder="What is the risk? Shown on hover and in the panel."
          value={risk}
          onChange={(e) => onRiskChange(e.target.value)}
          onFocus={onRiskFocus}
          onBlur={onRiskBlur}
        />
      )}
      {riskError && (
        <div className="hint bad" role="alert">
          {riskError}
        </div>
      )}
    </div>
  )
}

// Link rows edited as label/url pairs; `commit` saves on blur / remove, `error` is shown under the rows.
export function LinksField({
  links,
  setLinks,
  error,
  onFocus,
  onBlur,
  commit,
}: {
  links: LinkInput[]
  setLinks: (l: LinkInput[]) => void
  error: string
  onFocus: () => void
  onBlur: () => void
  commit: (l: LinkInput[]) => void
}) {
  // REQ_FE_121: Add link puts the focus in the new row's label.
  const labels = useRef<(HTMLInputElement | null)[]>([])
  const [focusLink, setFocusLink] = useState<number | null>(null)
  useEffect(() => {
    if (focusLink === null) return
    labels.current[focusLink]?.focus()
    setFocusLink(null)
  }, [focusLink])
  const blur = () => {
    onBlur()
    commit(links)
  }
  return (
    <div className="field">
      <label>Links</label>
      <div className="flex flex-col gap-2">
        {links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <input
              className={`inp basis-1/3 min-w-0${error ? ' bad' : ''}`}
              ref={(el) => {
                labels.current[i] = el
              }}
              maxLength={40}
              placeholder="Label, e.g. Jira epic"
              aria-label="Link label"
              value={l.label}
              onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              onFocus={onFocus}
              onBlur={blur}
            />
            <input
              className={`inp mono basis-2/3 min-w-0${error ? ' bad' : ''}`}
              placeholder="https://…"
              aria-label="Link URL"
              value={l.url}
              onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              onFocus={onFocus}
              onBlur={blur}
            />
            <button
              type="button"
              className="btn icon ghost sm"
              aria-label={`Remove link ${l.label || i + 1}`}
              onClick={() => {
                const next = links.filter((_, j) => j !== i)
                setLinks(next)
                commit(next)
              }}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setLinks([...links, { label: '', url: '' }])
            setFocusLink(links.length)
          }}
        >
          + Add link
        </button>
      </div>
      <div className="hint">Jira epic, RFC, ADR or any other artefact — a label and a URL.</div>
      {error && (
        <div className="hint bad" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

// Validates and cleans link rows for a save; an error when a row is half-filled.
export function cleanLinks(next: LinkInput[]): { cleaned: LinkInput[] } | { error: string } {
  const bad = next.some((l) => (trimName(l.label) || l.url.trim()) && (!trimName(l.label) || !/^https?:\/\//i.test(l.url.trim())))
  if (bad) return { error: 'Each link needs a label and an http(s) URL' }
  return { cleaned: next.filter((l) => trimName(l.label)).map((l) => ({ label: trimName(l.label), url: l.url.trim() })) }
}
