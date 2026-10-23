import { useEffect, useState } from 'react'
import { fetchIcons, putIconLabel } from '../../api/resources'
import type { Icon } from '../../api/types'
import { apiError, sessionRefusal } from '../../lib/apiError'
import { ICONS } from '../../lib/icons'
import { BTN, BTN_PRIMARY, INPUT, trimName } from '../../lib/ui'

// REQ_FE_080: the 20 icons are fixed; only their labels change, for everyone at once. The roadmap page
// re-reads GET /api/icons whenever it mounts, so a saved label shows there the moment you go back.
export function IconLabelsCard() {
  const [saved, setSaved] = useState<Icon[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchIcons()
      .then((items) => {
        if (cancelled) return
        setSaved(items)
        setDrafts(Object.fromEntries(items.map((i) => [i.key, i.label])))
      })
      .catch(() => !cancelled && setLoadError('Could not load the icon labels.'))
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    if (!saved) return
    setBusy(true)
    setNotice('')
    setErrors({})
    const next = [...saved]
    const errs: Record<string, string> = {}
    for (const [i, icon] of saved.entries()) {
      const label = trimName(drafts[icon.key] ?? icon.label)
      if (label === icon.label) continue
      try {
        next[i] = await putIconLabel(icon.key, label)
      } catch (err) {
        const e = apiError(err)
        errs[icon.key] = sessionRefusal(err) ?? (e.status === 422 ? 'A label is required (at most 200 characters).' : 'Could not save this label.')
      }
    }
    setSaved(next)
    setDrafts((d) => ({ ...d, ...Object.fromEntries(next.map((n) => [n.key, errs[n.key] ? (d[n.key] ?? n.label) : n.label])) }))
    setErrors(errs)
    if (Object.keys(errs).length === 0) setNotice('Labels saved.')
    setBusy(false)
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4" id="admin-icons" aria-labelledby="admin-icons-h">
      <div className="flex items-center gap-3 mb-1">
        <h2 id="admin-icons-h" className="font-semibold text-lg flex-1">
          Icon labels
        </h2>
        <button
          type="button"
          className={BTN}
          onClick={() => setDrafts(Object.fromEntries((saved ?? []).map((i) => [i.key, ICONS[i.key]?.defaultLabel ?? i.label])))}
        >
          Reset all to defaults
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={busy || !saved} onClick={() => void save()}>
          Save labels
        </button>
      </div>
      <p className="text-sm text-text-2 mb-3">
        The 20 icons are fixed. Only the display label can change; it applies to every roadmap.
      </p>
      {loadError && (
        <p className="text-danger text-sm" role="alert">
          {loadError}
        </p>
      )}
      {notice && (
        <p className="text-ok text-xs mb-2" role="status">
          {notice}
        </p>
      )}
      {saved === null && !loadError && <p className="text-text-2 text-sm">Loading…</p>}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {saved?.map((i) => {
          const Glyph = ICONS[i.key]?.Icon
          const edited = (drafts[i.key] ?? i.label) !== i.label
          return (
            <div key={i.key} className="flex flex-col">
              <label className="flex items-center gap-2 text-sm">
                {Glyph && <Glyph size={16} aria-hidden="true" />}
                <span className="w-20 text-text-3 text-xs">{i.key}</span>
                <input
                  className={`${INPUT} flex-1 ${edited ? 'bg-accent-soft' : ''}`}
                  aria-label={`Label for ${i.key}`}
                  value={drafts[i.key] ?? i.label}
                  onChange={(e) => setDrafts((d) => ({ ...d, [i.key]: e.target.value }))}
                />
              </label>
              {errors[i.key] && (
                <span className="text-danger text-xs" role="alert">
                  {errors[i.key]}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-text-3 mt-2">Edited label shown highlighted. Labels appear on hover for every viewer.</p>
    </section>
  )
}
