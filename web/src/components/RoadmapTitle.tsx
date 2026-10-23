import { trimName } from '../lib/ui'
import { useEffect, useState } from 'react'
import { useCanEdit } from '../lib/canEdit'
import { renameRoadmap } from '../api/resources'
import { sessionRefusal } from '../lib/apiError'
import type { Roadmap } from '../api/types'

// REQ_FE_001: click to rename, Enter/blur saves, Esc cancels.
export function RoadmapTitle({ roadmap, onRenamed }: { roadmap: Roadmap; onRenamed: (r: Roadmap) => void }) {
  const canEdit = useCanEdit()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(roadmap.title)
  // A rename the server hasn't accepted (e.g. a 401 because the session ended, REQ_AUTH_007) stays on screen
  // so what the user typed is never visually lost; it clears once the saved title catches up or they edit again.
  const [unsaved, setUnsaved] = useState<string | null>(null)
  const [note, setNote] = useState('not saved yet')

  useEffect(() => {
    if (unsaved !== null && roadmap.title === unsaved) setUnsaved(null)
  }, [roadmap.title, unsaved])

  function open() {
    if (!canEdit) return
    setValue(unsaved ?? roadmap.title)
    setUnsaved(null)
    setEditing(true)
  }

  async function commit() {
    setEditing(false)
    const v = trimName(value)
    if (!v || v === roadmap.title) return
    try {
      const updated = await renameRoadmap(roadmap.id, v)
      onRenamed(updated)
    } catch (err) {
      setUnsaved(v)
      setNote(sessionRefusal(err) ?? 'not saved yet')
      console.error('roadmap.rename_failed', { id: roadmap.id })
    }
  }

  function cancel() {
    setEditing(false)
    setValue(roadmap.title)
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Roadmap title"
        className="title-input text-2xl font-semibold border border-border rounded px-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
      />
    )
  }

  return (
    <h1
      className="title text-2xl font-semibold"
      id="rm-title"
      data-editable={canEdit ? '1' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      role={canEdit ? 'button' : undefined}
      aria-label={canEdit ? 'Click to rename the roadmap' : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (canEdit && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
    >
      {unsaved ?? roadmap.title}
      {unsaved !== null && (
        <small className="ml-2 text-sm font-normal text-danger" data-testid="title-unsaved">
          {note}
        </small>
      )}
    </h1>
  )
}
