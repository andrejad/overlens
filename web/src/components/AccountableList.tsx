import type { ItemKind } from '../api/types'
import type { ChainHealth } from '../lib/chainHealth'
import { STATUS } from '../lib/status'
import { Marker } from './DependencyPicker'

// REQ_DEP_039: the trace's side panel with nothing selected — the chain's roadmap items by responsible person
// (chainHealth sorts them), each with its status and, when not done, its gaps. A click selects the item.
export function AccountableList({ health, rootKey, onPick }: { health: ChainHealth; rootKey: string; onPick: (kind: ItemKind, id: number) => void }) {
  const owners = health.owners.filter((o) => o.owner !== '').length
  return (
    <div data-testid="accountable">
      <h3 className="text-base font-semibold">Accountable</h3>
      <div className="hint">
        {health.items.size} roadmap items · {owners} {owners === 1 ? 'owner' : 'owners'}
      </div>
      {health.owners.map((g) => (
        <div key={g.owner} className="mt-3.5" data-testid="accountable-group">
          <div className={`text-sm font-semibold mb-1.5 ${g.owner === '' ? 'text-danger' : ''}`} data-testid="accountable-owner">
            {g.owner === '' ? 'No owner' : g.owner}
          </div>
          {g.items.map((it) => {
            const gaps =
              it.status === 'done'
                ? []
                : [...(it.overdue ? ['Overdue'] : []), ...(it.gap ? ['No prerequisites'] : []), ...it.tightBefore.map((t) => `${t.days} days before ${t.name}`)]
            return (
              <button
                key={it.key}
                type="button"
                className={`dep-item w-full text-left flex-wrap${it.key === rootKey ? ' ring-2 ring-accent' : ''}`}
                data-testid="accountable-item"
                data-key={it.key}
                onClick={() => onPick(it.kind, it.id)}
              >
                <Marker kind={it.kind} />
                <span className="text-text-3 text-xs font-semibold">{it.tag}</span>
                <span className="flex-1 min-w-0 truncate">{it.name}</span>
                <span className={`tag st-tag st-${it.status}`}>{STATUS[it.status].label}</span>
                {gaps.length > 0 && (
                  <span className="basis-full flex flex-wrap gap-1" data-testid="accountable-gaps">
                    {gaps.map((x) => (
                      <span key={x} className="gap-note">
                        {x}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
