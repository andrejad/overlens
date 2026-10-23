import { trimName } from '../lib/ui'
import { useEffect, useRef, useState } from 'react'
import { contrastRatio, fgOf } from '../lib/contrast'
import { ICONS, ICON_KEYS } from '../lib/icons'
import { patchDeliverable } from '../api/resources'
import { dateBounds, itemEdges } from '../lib/depBounds'
import { dateOrderMessage } from '../lib/depErrors'
import { refusalMessage, sessionRefusal } from '../lib/apiError'
import { formatDate } from '../lib/dates'
import { edgeEnds, itemKey } from '../timeline/deps'
import type { Deliverable, DependencyEdge, DepEnd, ItemKind, Icon, LinkInput, RoadmapFull, Status, Team, Workstream } from '../api/types'
import { CAP_MESSAGE, dayOf } from '../timeline/axis'
import { capCheck, wallsFor } from '../timeline/drag'
import { MoveItemDialog } from './MoveItemDialog'
import { packRoadmap } from '../timeline/pack'
import { DescriptionEditor } from './DescriptionEditor'
import { DependenciesField } from './DependencyPicker'
import { LinksField, StatusField, cleanLinks } from './ItemFormFields'

// REQ_FE_025: the same field set as the full edit modal, so quick-edit and the modal structurally
// cannot drift apart — both mount this one component. REQ_FE_026/027: autosave, one field per
// request, inline validation error that keeps what was typed and never touches other fields.

// M1 (review finding): a typed date that would overlap an untouched neighbour in the deliverable's
// current row must be rejected here, before the request ever goes out — otherwise pack.ts's sticky
// tie-break could resolve the resulting conflict by relocating that *other*, untouched deliverable to
// another row, which REQ_FE_013 (a hard rule) forbids as a side effect of an edit.
export const OVERLAP_MESSAGE = 'That spot is taken — it would overlap another item, so nothing was saved'

// The Phase 0 wireframe's swatch palette.
const SWATCHES = ['#2f6bd7', '#3b5bdb', '#6d4fd1', '#7c3aed', '#e0679a', '#d9534f', '#c2410c', '#f2994a', '#f4c542', '#2f9e6b', '#0f766e', '#2bb3b1', '#64748b', '#334155']

function isValidHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v)
}

// the better of the two automatic text colors against the fill
// REQ_FE_120: the items that set the date limits: the prerequisite ending last and the dependent starting first.
export function limitingItems(edges: DependencyEdge[], id: number, kind: ItemKind = 'deliverable'): { by: DepEnd | null; bl: DepEnd | null } {
  const me = itemKey(kind, id)
  let by: DepEnd | null = null
  let bl: DepEnd | null = null
  for (const e of edges) {
    const o = e.other
    if (!o) continue
    const ends = edgeEnds(e)
    if (ends.to === me && (!by || o.end_date > by.end_date)) by = o
    if (ends.from === me && (!bl || o.start_date < bl.start_date)) bl = o
  }
  return { by, bl }
}

const bestContrast = (hex: string) => Math.max(contrastRatio(hex, '#000000'), contrastRatio(hex, '#ffffff'))

export function DeliverableEditForm({
  deliverable,
  team,
  workstreams,
  roadmap,
  icons = [],
  onSaved,
  onDependenciesChanged = () => {},
  onDone,
  pendingSaves,
}: {
  deliverable: Deliverable
  team: Team
  workstreams: Workstream[]
  roadmap: RoadmapFull
  // Phase 4 (REQ_FE_080): GET /api/icons's effective labels, fetched once by the page and passed
  // down the same way `team`/`workstreams` already are. Defaulted to `[]` so a render before the
  // fetch resolves still works — commitIcons then falls back to lib/icons.ts's hardcoded defaults.
  icons?: Icon[]
  onSaved: (d: Deliverable) => void
  // Phase 5: fires after a dependency is added/removed so the page can refetch the roadmap (arrows).
  onDependenciesChanged?: () => void
  // REQ_FE_114: the panel passes this to get a Done button that leaves edit mode. It saves nothing
  // (every field has already saved); without it (the full edit window) no button is rendered.
  onDone?: () => void
  // REQ_FE_119: the edit window passes this to wait for the saves still running before Escape closes it.
  pendingSaves?: { current: Set<Promise<void>> }
}) {
  // Phase 5 (REQ_DEP_004/006): the edges touching this deliverable give the date bounds shown under
  // the dates; they come from the roadmap the page holds, which it refetches after a dependency change.
  const edges = itemEdges(roadmap.dependencies, 'deliverable', deliverable.id)
  // Day after the latest prerequisite end / day before the earliest dependent start; the other end may be a milestone (REQ_DEP_026).
  const { earliest: earliestStart, latest: latestEnd } = dateBounds(edges, 'deliverable', deliverable.id)
  const { by: limitedBy, bl: limitedByDependent } = limitingItems(edges, deliverable.id)
  // REQ_FE_120: "Can’t start before Mar 3, 2026 — <name> ends Mar 2, 2026"; the server's 409 names the item the same way.
  const startRefusal = (iso: string) =>
    limitedBy ? `Can’t start before ${formatDate(iso)} — ${limitedBy.name} ends ${formatDate(limitedBy.end_date)}` : `Can’t start before ${formatDate(iso)} — a prerequisite ends the day before`
  const endRefusal = (iso: string) =>
    limitedByDependent ? `Can’t end after ${formatDate(iso)} — ${limitedByDependent.name} starts ${formatDate(limitedByDependent.start_date)}` : `Can’t end after ${formatDate(iso)} — a dependent starts the day after`

  const [name, setName] = useState(deliverable.name)
  const [nameError, setNameError] = useState('')
  const [start, setStart] = useState(deliverable.start_date)
  const [end, setEnd] = useState(deliverable.end_date)
  const [dateError, setDateError] = useState('')
  const [responsible, setResponsible] = useState(deliverable.responsible_person ?? '')
  const [responsibleError, setResponsibleError] = useState('')
  const [hex, setHex] = useState(deliverable.color)
  const [hexError, setHexError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [risk, setRisk] = useState(deliverable.risk_note ?? '')
  const [riskError, setRiskError] = useState('')
  const [workstreamsError, setWorkstreamsError] = useState('')
  const [iconsError, setIconsError] = useState('')
  const [descriptionError, setDescriptionError] = useState('')
  // Edited as label/url pairs (LinkInput) — id/position are server-assigned and irrelevant while
  // editing; commitLinks strips back down to this shape before every save anyway.
  const [links, setLinks] = useState<LinkInput[]>(deliverable.links.map((l) => ({ label: l.label, url: l.url })))
  const [linksError, setLinksError] = useState('')
  const [moving, setMoving] = useState(false)
  // H1 fix: this form's local state is a draft copy of `deliverable`, snapshotted once per field.
  // But `deliverable` isn't static — a drag on the timeline, or a save from the *other* mounted
  // instance of this same form (panel vs. full modal, REQ_FE_025), can change it out from under an
  // open form. Without this, blurring an untouched field would re-send its now-stale local value
  // and silently overwrite whatever just changed it. So: whenever the prop changes, resync every
  // field the user isn't actively typing in right now (tracked via onFocus/onBlur below) to the
  // fresh server value; a field mid-edit is left alone so this can't clobber in-progress typing.
  const focused = useRef<Set<string>>(new Set())
  function trackFocus(key: string) {
    return { onFocus: () => focused.current.add(key) }
  }
  useEffect(() => {
    if (!focused.current.has('name')) setName(deliverable.name)
    if (!focused.current.has('start')) setStart(deliverable.start_date)
    if (!focused.current.has('end')) setEnd(deliverable.end_date)
    if (!focused.current.has('responsible')) setResponsible(deliverable.responsible_person ?? '')
    if (!focused.current.has('hex')) setHex(deliverable.color)
    if (!focused.current.has('risk')) setRisk(deliverable.risk_note ?? '')
    if (!focused.current.has('links')) setLinks(deliverable.links.map((l) => ({ label: l.label, url: l.url })))
  }, [deliverable])

  // H3 fix: saves every field in `fields` as one PATCH request. commitDates uses this directly with
  // both start_date and end_date together — sending them as two separate requests (the old shape)
  // meant a new start date invalid against the *old* stored end could 422 on its own request while
  // the end-date request still went through, saving a mismatched range nobody asked for.
  function commitFields(fields: Record<string, unknown>, onError: (message: string) => void, label: string) {
    const p = saveFields(fields, onError, label)
    pendingSaves?.current.add(p)
    void p.finally(() => pendingSaves?.current.delete(p))
    return p
  }

  async function saveFields(fields: Record<string, unknown>, onError: (message: string) => void, label: string) {
    try {
      const updated = await patchDeliverable(deliverable.id, fields)
      onSaved(updated)
    } catch (err) {
      // REQ_DEP_004/006: a 409 date_order is surfaced inline with the bound the server reports.
      const body = (err as { response?: { data?: { error?: { code?: string; earliest_start?: string; latest_end?: string } } } })?.response?.data?.error
      const named =
        body?.code === 'date_order'
          ? (body.earliest_start && limitedBy ? startRefusal(body.earliest_start) : '') || (body.latest_end && limitedByDependent ? endRefusal(body.latest_end) : '')
          : ''
      const message =
        sessionRefusal(err) ||
        named ||
        dateOrderMessage(err)?.replace(/\d{4}-\d{2}-\d{2}/g, formatDate) ||
        refusalMessage(err) ||
        `Could not save ${label}`
      onError(message)
    }
  }

  async function commit(field: string, value: unknown, label: string) {
    // M2 (review finding): every field that can be rejected by the server needs a visible place to
    // show that rejection — a silently-dropped onError left status/responsible/risk/workstreams/
    // description looking like they saved even on a 422.
    const onError =
      field === 'name' ? setNameError :
      field === 'start_date' || field === 'end_date' ? setDateError :
      field === 'color' ? setHexError :
      field === 'links' ? setLinksError :
      field === 'responsible_person' ? setResponsibleError :
      field === 'status' ? setStatusError :
      field === 'risk_note' ? setRiskError :
      field === 'workstream_ids' ? setWorkstreamsError :
      field === 'icons' ? setIconsError :
      field === 'description_html' ? setDescriptionError :
      () => {}
    await commitFields({ [field]: value }, onError, label)
  }

  function commitName() {
    const v = trimName(name)
    if (!v) {
      setNameError('A title is required')
      return
    }
    setNameError('')
    if (v === deliverable.name) return
    void commit('name', v, 'title')
  }

  function commitDates() {
    if (!start || !end) return
    if (end < start) {
      setDateError('End can’t be before the start date')
      return
    }
    setDateError('')
    if (start === deliverable.start_date && end === deliverable.end_date) return

    // REQ_DEP_004/006: never send a date that breaks a dependency; the server enforces it too.
    if (earliestStart && start < earliestStart) {
      setDateError(startRefusal(earliestStart))
      return
    }
    if (latestEnd && end > latestEnd) {
      setDateError(endRefusal(latestEnd))
      return
    }

    const newStart = dayOf(start)
    const newEnd = dayOf(end)

    // M1: reject a typed date that would overlap the untouched neighbour occupying this deliverable's
    // current row, the same wall a drag would stop at (REQ_FE_012/013) — read-only use of pack.ts/
    // drag.ts, computed fresh from the roadmap prop so it reflects the deliverable's real stored row.
    const layout = packRoadmap(roadmap, true)
    const walls = wallsFor(layout, deliverable.id, dayOf(deliverable.start_date), dayOf(deliverable.end_date))
    if ((walls.lo !== null && newStart < walls.lo) || (walls.hi !== null && newEnd > walls.hi)) {
      setDateError(OVERLAP_MESSAGE)
      return
    }

    // M4: block a date edit that would push the roadmap's span past the 3-year cap, before the
    // request ever goes out (REQ_FE_062, a hard rule) — mirrors the server and the drag-time check.
    if (!capCheck(roadmap, deliverable.id)(newStart, newEnd)) {
      setDateError(CAP_MESSAGE)
      return
    }

    const fields: Record<string, unknown> = {}
    if (start !== deliverable.start_date) fields.start_date = start
    if (end !== deliverable.end_date) fields.end_date = end
    void commitFields(fields, setDateError, 'dates')
  }

  function commitResponsible() {
    if (responsible === (deliverable.responsible_person ?? '')) return
    setResponsibleError('')
    void commit('responsible_person', responsible, 'responsible person')
  }

  function commitColor() {
    if (!isValidHex(hex)) {
      setHexError('Enter a color as #rrggbb')
      return
    }
    setHexError('')
    if (hex.toLowerCase() === deliverable.color.toLowerCase()) return
    void commit('color', hex, 'color')
  }

  function pickSwatch(c: string) {
    setHex(c)
    setHexError('')
    if (c.toLowerCase() === deliverable.color.toLowerCase()) return
    void commit('color', c, 'color')
  }

  function resetToTeamColor() {
    setHex(team.default_color)
    setHexError('')
    void commit('color', team.default_color, 'color')
  }

  function commitStatus(s: Status) {
    if (s === deliverable.status) return
    setStatusError('')
    void commit('status', s, 'status')
  }

  function commitRisk() {
    if (deliverable.status !== 'at_risk') return
    if (risk === (deliverable.risk_note ?? '')) return
    setRiskError('')
    void commit('risk_note', risk, 'risk note')
  }

  function commitWorkstreams(id: number, checked: boolean) {
    const current = deliverable.workstream_ids
    const next = checked ? [...current, id] : current.filter((w) => w !== id)
    if (next.length === 0) {
      // REQ_FE_121 / REQ_FE_027: nothing is sent; the message stays under the chips.
      setWorkstreamsError('At least one workstream is required')
      return
    }
    setWorkstreamsError('')
    void commit('workstream_ids', next, 'workstreams')
  }

  // Phase 4 (REQ_FE_080): same "replaces the whole array" autosave-on-click semantics
  // commitWorkstreams already follows for workstream_ids — a click toggles one key in/out of the
  // deliverable's icons and immediately PATCHes the full resulting array.
  function commitIcons(key: string, checked: boolean) {
    const current = deliverable.icons
    const next = checked ? [...current, key] : current.filter((k) => k !== key)
    setIconsError('')
    void commit('icons', next, 'icons')
  }

  function commitLinks(next: LinkInput[]) {
    const r = cleanLinks(next)
    if ('error' in r) {
      setLinksError(r.error)
      return
    }
    setLinksError('')
    void commit('links', r.cleaned, 'links')
  }

  // REQ_FE_080: the chosen icons' (effective) labels, listed under the tiles in the panel's icon order.
  const chosenIconNames = ICON_KEYS.filter((k) => deliverable.icons.includes(k)).map(
    (k) => icons.find((i) => i.key === k)?.label ?? ICONS[k].defaultLabel,
  )
  const shownHex = isValidHex(hex) ? hex : deliverable.color

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => e.preventDefault()}
      aria-label="Deliverable quick-edit form"
    >
      <div className="field">
        <label htmlFor="d-name">
          Title
        </label>
        <input
          id="d-name"
          className={`inp${nameError ? ' bad' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...trackFocus('name')}
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

      <div className="flex gap-3">
        <div className="field flex-1">
          <label htmlFor="d-start">
            Start date
          </label>
          <input
            id="d-start"
            type="date"
            className={`inp${dateError ? ' bad' : ''}`}
            value={start}
            min={earliestStart ?? undefined}
            max={latestEnd ?? undefined}
            onChange={(e) => setStart(e.target.value)}
            {...trackFocus('start')}
            onBlur={() => {
              focused.current.delete('start')
              commitDates()
            }}
          />
          <div className="hint" data-testid="start-limit">
            {earliestStart && limitedBy
              ? `Earliest start ${formatDate(earliestStart)} — ${limitedBy.name} ends ${formatDate(limitedBy.end_date)}`
              : 'No prerequisite limits the start'}
          </div>
        </div>
        <div className="field flex-1">
          <label htmlFor="d-end">
            End date
          </label>
          <input
            id="d-end"
            type="date"
            className={`inp${dateError ? ' bad' : ''}`}
            value={end}
            min={earliestStart ?? undefined}
            max={latestEnd ?? undefined}
            onChange={(e) => setEnd(e.target.value)}
            {...trackFocus('end')}
            onBlur={() => {
              focused.current.delete('end')
              commitDates()
            }}
          />
          <div className="hint" data-testid="end-limit">
            {latestEnd && limitedByDependent
              ? `Latest end ${formatDate(latestEnd)} — ${limitedByDependent.name} starts ${formatDate(limitedByDependent.start_date)}`
              : 'No dependent limits the end'}
          </div>
        </div>
      </div>
      {dateError && (
        <div className="hint bad" role="alert">
          {dateError}
        </div>
      )}

      <StatusField
        status={deliverable.status}
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
        <label htmlFor="d-responsible">
          Responsible person
        </label>
        <input
          id="d-responsible"
          className={`inp${responsibleError ? ' bad' : ''}`}
          value={responsible}
          onChange={(e) => setResponsible(e.target.value)}
          {...trackFocus('responsible')}
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

      <div className="field">
        <label>Team</label>
        <div>
          <span>{team.name}</span>{' '}
          <button
            type="button"
            className="move-link text-accent underline text-xs"
            title="Move this deliverable to another team"
            onClick={() => setMoving(true)}
          >
            (move)
          </button>
        </div>
        {moving && <MoveItemDialog kind="deliverable" item={deliverable} roadmap={roadmap} onClose={() => setMoving(false)} onMoved={() => onDependenciesChanged()} />}
      </div>

      <div className="field">
        <label htmlFor="d-hex">
          Deliverable color
        </label>
        <div className={`swatches${hexError ? ' bad' : ''}`}>
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={hex.toLowerCase() === c ? 'on' : undefined}
              style={{ background: c }}
              title={c}
              aria-label={`Color ${c}`}
              aria-pressed={hex.toLowerCase() === c}
              onClick={() => pickSwatch(c)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <input
            id="d-hex"
            className={`inp mono${hexError ? ' bad' : ''}`}
            style={{ width: 112, height: 30 }}
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            {...trackFocus('hex')}
            onBlur={() => {
              focused.current.delete('hex')
              commitColor()
            }}
          />
          <span className="pv" style={{ background: shownHex, color: fgOf(shownHex) }}>
            {name || 'Deliverable'}
          </span>
          <button type="button" className="btn ghost sm" onClick={resetToTeamColor}>
            Reset to team color
          </button>
        </div>
        {isValidHex(hex) && (
          <div className="hint" data-testid="contrast-hint">
            Text auto-set to {fgOf(hex) === '#ffffff' ? 'white' : 'dark'} · {bestContrast(hex).toFixed(1)}:1 · AA
          </div>
        )}
        {hexError && (
          <div className="hint bad" role="alert">
            {hexError}
          </div>
        )}
      </div>

      <div className="field">
        <label>Icon labels</label>
        <div className={`tiles${iconsError ? ' bad' : ''}`}>
          {ICON_KEYS.map((key) => {
            const { Icon: IconComp, defaultLabel } = ICONS[key]
            const label = icons.find((i) => i.key === key)?.label ?? defaultLabel
            const active = deliverable.icons.includes(key)
            return (
              <button
                key={key}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={active}
                className={`tile${active ? ' on' : ''}`}
                onClick={() => commitIcons(key, !active)}
              >
                <IconComp size={16} />
              </button>
            )
          })}
        </div>
        <div className="hint" data-testid="icon-names">
          {chosenIconNames.length ? chosenIconNames.join(' · ') : 'No labels'}
        </div>
        {iconsError && (
          <div className="hint bad" role="alert">
            {iconsError}
          </div>
        )}
      </div>

      {workstreams.length > 0 && (
        <div className="field">
          <label>Workstreams</label>
          <div className={`wschips${workstreamsError ? ' bad' : ''}`}>
            {workstreams.map((w) => {
              const on = deliverable.workstream_ids.includes(w.id)
              return (
                <label key={w.id} className={`wschip${on ? ' on' : ''}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={(e) => commitWorkstreams(w.id, e.target.checked)} />
                  <span className="cb" aria-hidden="true">{on ? '✓' : ''}</span>
                  {w.name}
                </label>
              )
            })}
          </div>
          {workstreamsError && (
            <div className="hint bad" role="alert">
              {workstreamsError}
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label>Description</label>
        <DescriptionEditor
          invalid={!!descriptionError}
          html={deliverable.description_html ?? ''}
          onCommit={(html) => {
            if (html === (deliverable.description_html ?? '')) return
            setDescriptionError('')
            void commit('description_html', html, 'description')
          }}
        />
        {descriptionError && (
          <div className="hint bad" role="alert">
            {descriptionError}
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

      <DependenciesField
        item={{ kind: 'deliverable', id: deliverable.id }}
        itemKind="deliverable"
        edges={edges}
        onChanged={onDependenciesChanged}
      />

      {onDone && (
        <div className="form-foot">
          <button type="button" className="btn primary" onClick={onDone} aria-label="Done editing" data-testid="edit-done">
            Done
          </button>
        </div>
      )}
    </form>
  )
}
