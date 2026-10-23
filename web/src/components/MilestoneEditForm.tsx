import { useEffect, useRef, useState } from 'react'
import { patchMilestone } from '../api/resources'
import { dateBounds, itemEdges } from '../lib/depBounds'
import { dateOrderMessage } from '../lib/depErrors'
import { refusalMessage, sessionRefusal } from '../lib/apiError'
import { formatDate } from '../lib/dates'
import { trimName } from '../lib/ui'
import { CAP_MESSAGE, dayOf } from '../timeline/axis'
import { capCheck, wallsFor } from '../timeline/drag'
import { packRoadmap } from '../timeline/pack'
import type { LinkInput, Milestone, RoadmapFull, Status } from '../api/types'
import { DependenciesField } from './DependencyPicker'
import { DescriptionEditor } from './DescriptionEditor'
import { LinksField, StatusField, cleanLinks } from './ItemFormFields'
import { MoveItemDialog } from './MoveItemDialog'
import { OVERLAP_MESSAGE, limitingItems } from './DeliverableEditForm'

// REQ_FE_100: the milestone panel's edit mode, styled like the deliverable form. Every field saves by itself
// (REQ_FE_026, PATCH with only that field); a refused value stays in its field with the message under it (REQ_FE_027).
export function MilestoneEditForm({
  milestone,
  roadmap,
  onSaved,
  onMoved,
  onDependenciesChanged = () => {},
  onDone,
}: {
  milestone: Milestone
  roadmap: RoadmapFull
  onSaved: (m: Milestone) => void
  onMoved: (m: Milestone) => void
  onDependenciesChanged?: () => void
  onDone: () => void
}) {
  const edges = itemEdges(roadmap.dependencies, 'milestone', milestone.id) // from the roadmap the page holds
  const { earliest, latest } = dateBounds(edges, 'milestone', milestone.id)
  const { by, bl } = limitingItems(edges, milestone.id, 'milestone')
  const beforeRefusal = (iso: string) =>
    by ? `Can’t be before ${formatDate(iso)} — ${by.name} ends ${formatDate(by.end_date)}` : `Can’t be before ${formatDate(iso)} — a prerequisite ends the day before`
  const afterRefusal = (iso: string) =>
    bl ? `Can’t be after ${formatDate(iso)} — ${bl.name} starts ${formatDate(bl.start_date)}` : `Can’t be after ${formatDate(iso)} — a dependent starts the day after`

  const [name, setName] = useState(milestone.name)
  const [date, setDate] = useState(milestone.date)
  const [wsId, setWsId] = useState(milestone.workstream_id)
  const [nameError, setNameError] = useState('')
  const [dateError, setDateError] = useState('')
  const [wsError, setWsError] = useState('')
  const [descError, setDescError] = useState('')
  const [responsible, setResponsible] = useState(milestone.responsible_person ?? '')
  const [responsibleError, setResponsibleError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [risk, setRisk] = useState(milestone.risk_note ?? '')
  const [riskError, setRiskError] = useState('')
  const asInputs = (m: Milestone): LinkInput[] => (m.links ?? []).map((l) => ({ label: l.label, url: l.url }))
  const [links, setLinks] = useState<LinkInput[]>(asInputs(milestone))
  const [linksError, setLinksError] = useState('')
  const [moving, setMoving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  // a drag (or another save) can change the milestone while the form is open: resync every field not being typed in
  const focused = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!focused.current.has('name')) setName(milestone.name)
    if (!focused.current.has('date')) setDate(milestone.date)
    setWsId(milestone.workstream_id)
    if (!focused.current.has('responsible')) setResponsible(milestone.responsible_person ?? '')
    if (!focused.current.has('risk')) setRisk(milestone.risk_note ?? '')
    if (!focused.current.has('links')) setLinks(asInputs(milestone))
  }, [milestone])

  async function commit(fields: Record<string, unknown>, onError: (m: string) => void, label: string) {
    try {
      const updated = await patchMilestone(milestone.id, fields)
      onSaved(updated)
    } catch (err) {
      onError(
        sessionRefusal(err) ||
        dateOrderMessage(err)?.replace(/\d{4}-\d{2}-\d{2}/g, formatDate) ||
          refusalMessage(err) ||
          `Could not save ${label}`,
      )
    }
  }

  function commitName() {
    const v = trimName(name)
    if (!v) return setNameError('A milestone needs a name')
    if (Array.from(v).length > 200) return setNameError('The name can be at most 200 characters')
    setNameError('')
    if (v === milestone.name) return
    void commit({ name: v }, setNameError, 'name')
  }

  function commitDate() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setDateError('Pick a date')
    setDateError('')
    if (date === milestone.date) return
    if (earliest && date < earliest) {
      setDateError(beforeRefusal(earliest))
      return
    }
    if (latest && date > latest) {
      setDateError(afterRefusal(latest))
      return
    }
    // REQ_FE_010: never overlap the untouched neighbours of the milestone's own row; REQ_FE_062: the 3-year span
    const day = dayOf(date)
    const walls = wallsFor(packRoadmap(roadmap, true), milestone.id, dayOf(milestone.date), dayOf(milestone.date), [], 'milestone')
    if ((walls.lo !== null && day < walls.lo) || (walls.hi !== null && day > walls.hi)) {
      setDateError(OVERLAP_MESSAGE)
      return
    }
    if (!capCheck(roadmap, milestone.id, 'milestone')(day, day)) {
      setDateError(CAP_MESSAGE)
      return
    }
    void commit({ date }, setDateError, 'date')
  }

  function commitResponsible() {
    if (responsible === (milestone.responsible_person ?? '')) return
    setResponsibleError('')
    void commit({ responsible_person: responsible }, setResponsibleError, 'responsible person')
  }

  function commitStatus(s: Status) {
    if (s === (milestone.status ?? 'planned')) return
    setStatusError('')
    void commit({ status: s }, setStatusError, 'status')
  }

  function commitRisk() {
    if (milestone.status !== 'at_risk') return
    if (risk === (milestone.risk_note ?? '')) return
    setRiskError('')
    void commit({ risk_note: risk }, setRiskError, 'risk note')
  }

  function commitLinks(next: LinkInput[]) {
    const r = cleanLinks(next)
    if ('error' in r) return setLinksError(r.error)
    setLinksError('')
    void commit({ links: r.cleaned }, setLinksError, 'links')
  }

  function pickWorkstream(id: number) {
    setWsId(id)
    setWsError('')
    if (id === milestone.workstream_id) return
    void commit({ workstream_id: id }, setWsError, 'workstream')
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()} aria-label="Milestone quick-edit form" data-testid="milestone-edit-form">
      <div className="field">
        <label htmlFor="m-name">Name</label>
        <input
          id="m-name"
          ref={nameRef}
          className={`inp${nameError ? ' bad' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => focused.current.add('name')}
          onBlur={() => {
            focused.current.delete('name')
            commitName()
          }}
        />
        {nameError && (
          <div className="hint bad" role="alert">
            {nameError}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="m-date">Date</label>
        <input
          id="m-date"
          type="date"
          className={`inp${dateError ? ' bad' : ''}`}
          value={date}
          min={earliest ?? undefined}
          max={latest ?? undefined}
          onChange={(e) => setDate(e.target.value)}
          onFocus={() => focused.current.add('date')}
          onBlur={() => {
            focused.current.delete('date')
            commitDate()
          }}
        />
        <div className="hint" data-testid="date-limit">
          {earliest && by ? `Earliest date ${formatDate(earliest)} — ${by.name} ends ${formatDate(by.end_date)}` : 'No prerequisite limits the date'}
        </div>
        <div className="hint" data-testid="date-limit-latest">
          {latest && bl ? `Latest date ${formatDate(latest)} — ${bl.name} starts ${formatDate(bl.start_date)}` : 'No dependent limits the date'}
        </div>
        {dateError && (
          <div className="hint bad" role="alert">
            {dateError}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="m-ws">Workstream</label>
        <select id="m-ws" className={`inp${wsError ? ' bad' : ''}`} value={wsId} onChange={(e) => pickWorkstream(Number(e.target.value))}>
          {roadmap.workstreams.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {wsError && (
          <div className="hint bad" role="alert">
            {wsError}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="m-responsible">Responsible person</label>
        <input
          id="m-responsible"
          className={`inp${responsibleError ? ' bad' : ''}`}
          value={responsible}
          onChange={(e) => setResponsible(e.target.value)}
          onFocus={() => focused.current.add('responsible')}
          onBlur={() => {
            focused.current.delete('responsible')
            commitResponsible()
          }}
        />
        {responsibleError && (
          <div className="hint bad" role="alert">
            {responsibleError}
          </div>
        )}
      </div>

      <StatusField
        status={milestone.status ?? 'planned'}
        statusError={statusError}
        onPick={commitStatus}
        risk={risk}
        riskError={riskError}
        onRiskChange={setRisk}
        onRiskFocus={() => focused.current.add('risk')}
        onRiskBlur={() => {
          focused.current.delete('risk')
          commitRisk()
        }}
      />

      <div className="field">
        <label>Description</label>
        <DescriptionEditor
          invalid={!!descError}
          html={milestone.description_html ?? ''}
          onCommit={(html) => {
            if (html === (milestone.description_html ?? '')) return
            setDescError('')
            void commit({ description_html: html }, setDescError, 'description')
          }}
        />
        {descError && (
          <div className="hint bad" role="alert">
            {descError}
          </div>
        )}
      </div>

      <LinksField
        links={links}
        setLinks={setLinks}
        error={linksError}
        onFocus={() => focused.current.add('links')}
        onBlur={() => focused.current.delete('links')}
        commit={commitLinks}
      />

      <div className="field">
        <label>Team</label>
        <div>
          {roadmap.team.name}{' '}
          <button type="button" className="move-link text-accent underline text-xs" title="Move this milestone to another team" onClick={() => setMoving(true)}>
            (move)
          </button>
        </div>
      </div>
      {moving && (
        <MoveItemDialog kind="milestone" item={milestone} roadmap={roadmap} onClose={() => setMoving(false)} onMoved={(m) => onMoved(m as Milestone)} />
      )}

      <DependenciesField
        item={{ kind: 'milestone', id: milestone.id }}
        itemKind="milestone"
        edges={edges}
        onChanged={onDependenciesChanged}
      />

      <div className="form-foot">
        <button type="button" className="btn primary" onClick={onDone} aria-label="Done editing" data-testid="edit-done">
          Done
        </button>
      </div>
    </form>
  )
}
