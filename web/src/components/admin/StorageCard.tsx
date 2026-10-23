import { useEffect, useState } from 'react'
import { fetchStorage } from '../../api/resources'
import type { StorageInfo } from '../../api/types'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

// REQ_FE_139: "Version 1.0.0 · built 2026-10-21 14:02 UTC · commit abc1234"; the parts a build did not stamp are left out.
function buildLine(i: StorageInfo): string {
  const t = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(i.build_time)
  return [`Version ${i.version || 'dev'}`, t && `built ${t[1]} ${t[2]} UTC`, i.commit && i.commit !== 'unknown' && `commit ${i.commit}`].filter(Boolean).join(' · ')
}

// REQ_FE_135: read-only disk figures from GET /api/admin/storage, after the running build (REQ_FE_139).
export function StorageCard() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchStorage()
      .then((r) => !cancelled && setInfo(r))
      .catch(() => !cancelled && setError('Could not load the storage figures.'))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="bg-surface border border-border rounded-lg p-4" id="admin-storage" aria-labelledby="admin-storage-h">
      <h2 id="admin-storage-h" className="font-semibold text-lg mb-2">
        Storage
      </h2>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : !info ? (
        <p className="text-text-2">Loading…</p>
      ) : (
        <>
        <p className="text-sm mb-2" data-testid="build-line">
          {buildLine(info)}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm" data-testid="storage-figures">
          <dt className="text-text-2">Database</dt>
          <dd>{fmtBytes(info.db_bytes)}</dd>
          <dt className="text-text-2">Logs</dt>
          <dd>
            {fmtBytes(info.log_bytes)} in {info.log_files} {info.log_files === 1 ? 'file' : 'files'}
          </dd>
          <dt className="text-text-2">Disk</dt>
          <dd>
            {fmtBytes(info.disk_free_bytes)} free of {fmtBytes(info.disk_total_bytes)}
          </dd>
        </dl>
        </>
      )}
    </section>
  )
}
