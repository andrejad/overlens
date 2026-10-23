// The status labels and icons, shared by the timeline's badges and the side panel (REQ_FE_112).
import { CircleCheck, CircleDashed, CircleDot, TriangleAlert } from 'lucide-react'
import type { Status } from '../api/types'

export const STATUS: Record<Status, { label: string; Icon: typeof CircleDot }> = {
  planned: { label: 'Planned', Icon: CircleDashed },
  in_progress: { label: 'In progress', Icon: CircleDot },
  done: { label: 'Done', Icon: CircleCheck },
  at_risk: { label: 'At risk', Icon: TriangleAlert },
}
