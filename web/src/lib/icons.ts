// Phase 4: the 20 fixed icons (REQ_FE_080, docs/API.md's Icons section). The API/DB key is an
// app-owned string, independent of which lucide-react component renders it — this table is the
// only place that mapping exists, so a future icon swap never touches the backend or the wire
// format. `defaultLabel` is the fallback GET /api/icons uses before any admin override; the label
// actually shown to a user always comes from the API response (effective label), never this
// constant directly, except as a pre-fetch fallback.
//
// Shared, read-only, by the timeline (bar rendering) and the icon picker — one place defines it, as with
// web/src/api/types.ts.

import {
  Bug,
  Clock,
  Cloud,
  Coins,
  Database,
  Flag,
  Flame,
  FlaskConical,
  Globe,
  Lightbulb,
  Link,
  Lock,
  PauseCircle,
  Rocket,
  Scale,
  Shield,
  Star,
  TriangleAlert,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export interface IconDef {
  Icon: LucideIcon
  defaultLabel: string
}

// Order matches docs/API.md's table (left column then right column), i.e. the spec's own order.
export const ICONS: Record<string, IconDef> = {
  star: { Icon: Star, defaultLabel: 'High priority' },
  coins: { Icon: Coins, defaultLabel: 'Budget impact' },
  clock: { Icon: Clock, defaultLabel: 'Time sensitive' },
  rocket: { Icon: Rocket, defaultLabel: 'Launch / GA' },
  flag: { Icon: Flag, defaultLabel: 'Key deliverable' },
  flask: { Icon: FlaskConical, defaultLabel: 'Experiment' },
  warning: { Icon: TriangleAlert, defaultLabel: 'Warning' },
  wrench: { Icon: Wrench, defaultLabel: 'Tech debt' },
  flame: { Icon: Flame, defaultLabel: 'Escalated' },
  bug: { Icon: Bug, defaultLabel: 'Quality focus' },
  lock: { Icon: Lock, defaultLabel: 'Blocked' },
  cloud: { Icon: Cloud, defaultLabel: 'Infrastructure' },
  link: { Icon: Link, defaultLabel: 'Has dependency' },
  database: { Icon: Database, defaultLabel: 'Data migration' },
  users: { Icon: Users, defaultLabel: 'Cross-team' },
  globe: { Icon: Globe, defaultLabel: 'Customer facing' },
  shield: { Icon: Shield, defaultLabel: 'Security' },
  bulb: { Icon: Lightbulb, defaultLabel: 'Innovation' },
  scale: { Icon: Scale, defaultLabel: 'Regulatory' },
  pause: { Icon: PauseCircle, defaultLabel: 'On hold' },
}

export const ICON_KEYS = Object.keys(ICONS)
