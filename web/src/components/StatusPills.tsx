import { AlertTriangle, CircleDot, CircleDashed, CheckCircle } from 'lucide-react'
import type { Deliverable, Milestone } from '../api/types'

// REQ_FE_043: header pills "N at risk"/"N in progress", counting deliverables and milestones together,
// computed from the lists the page holds (not by reading DOM), updating live as status changes.
export function StatusPills({ deliverables, milestones = [] }: { deliverables: Deliverable[]; milestones?: Milestone[] }) {
  const items = [...deliverables, ...milestones]
  const atRisk = items.filter((d) => d.status === 'at_risk').length
  const inProgress = items.filter((d) => d.status === 'in_progress').length
  return (
    <div className="flex gap-2" data-testid="status-pills">
      <span className="pill risk flex items-center gap-1 text-xs" data-status-pill="risk">
        <AlertTriangle size={13} /> <span className="n">{atRisk}</span> at risk
      </span>
      <span className="pill flex items-center gap-1 text-xs" data-status-pill="progress">
        <CircleDot size={13} /> <span className="n">{inProgress}</span> in progress
      </span>
    </div>
  )
}

// REQ_FE_042: the status legend shown on every roadmap screen.
export function StatusLegend() {
  return (
    <div className="flex gap-3 items-center text-xs text-text-2" data-testid="status-legend">
      <span className="flex items-center gap-1">
        <CircleDashed size={12} /> Planned
      </span>
      <span className="flex items-center gap-1">
        <CircleDot size={12} /> In progress
      </span>
      <span className="flex items-center gap-1">
        <CheckCircle size={12} /> Done
      </span>
      <span className="flex items-center gap-1">
        <AlertTriangle size={12} /> At risk
      </span>
    </div>
  )
}
