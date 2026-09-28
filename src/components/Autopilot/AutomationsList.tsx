/**
 * Automations list — the dense table-of-rules. Each row renders its rule as a
 * plain-English sentence with the dynamic parts in the accent colour, plus an
 * enabled toggle, status/side badges, last-fired and fires-today.
 */
'use client'

import { cn } from '@/lib/utils'
import { Icon } from './icons'
import { Button, SideBadge, StatusBadge, Toggle } from './primitives'
import { type BuilderRule, buildSentence } from './builderModel'

export interface ListItem {
  id: number
  name: string
  enabled: boolean
  mode: 'active' | 'dryrun'
  side: 'left' | 'right' | 'both'
  builder: BuilderRule
  lastFired: string
  firesToday: number
}

function RuleSentence({ b }: { b: BuilderRule }) {
  const chunks = buildSentence(b)
  return (
    <span className="text-[13px] leading-snug text-fg-2 text-pretty">
      {chunks.map((c, i) => (
        <span key={i} className={cn(c.mono && 'font-mono', c.hot && 'text-cool')}>{c.text}</span>
      ))}
    </span>
  )
}

function Row({ a, onToggle, onOpen }: { a: ListItem, onToggle: (id: number, enabled: boolean) => void, onOpen: (a: ListItem) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(a)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(a)
        }
      }}
      className="group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-line px-[18px] py-3.5 transition-colors first:border-t-0 hover:bg-active focus:outline-none focus-visible:bg-active min-[900px]:gap-4"
    >
      <div onClick={e => e.stopPropagation()} className="pt-0.5">
        <Toggle checked={a.enabled} onChange={() => onToggle(a.id, !a.enabled)} />
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{a.name}</span>
          <StatusBadge mode={a.enabled ? a.mode : 'paused'} />
          <SideBadge side={a.side} />
        </div>
        <RuleSentence b={a.builder} />
      </div>
      <div className="flex items-center gap-5 text-right">
        <div className="hidden sm:block">
          <div className="sp-label">Last fired</div>
          <div className="font-mono text-[12px] text-fg-2">{a.lastFired}</div>
        </div>
        <div className="hidden w-16 md:block">
          <div className="sp-label">Today</div>
          <div className="font-mono text-[12px] text-fg-2">
            {a.firesToday}
            {' '}
            fire
            {a.firesToday === 1 ? '' : 's'}
          </div>
        </div>
        <Icon.ChevRight size={16} className="text-fg-3 transition-colors group-hover:text-fg-2" />
      </div>
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid place-items-center px-2 py-12 min-[900px]:py-16">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-card border border-line-2 text-cool">
          <Icon.Sliders size={22} />
        </div>
        <h3 className="text-[17px] font-medium text-fg">No automations yet</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-2 text-pretty">
          Autopilot reacts to live signals — movement, heart rate, ambient temperature — instead of just the clock.
          Build a rule as
          {' '}
          <span className="text-fg">When</span>
          {' '}
          ·
          {' '}
          <span className="text-fg">If</span>
          {' '}
          ·
          {' '}
          <span className="text-fg">Then</span>
          , then backtest it against past nights before it ever touches your bed.
        </p>
        <div className="mt-6 flex justify-center">
          <Button variant="accent" size="lg" onClick={onNew}>
            <Icon.Plus size={16} />
            New automation
          </Button>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-3 text-left min-[480px]:grid-cols-2">
          {[{ t: 'Hold ambient + 3°F overnight', s: 'continuous policy' }, { t: 'Cool down when restless', s: 'edge-triggered rule' }].map((x, i) => (
            <div key={i} className="rounded-ctl border border-dashed border-line-2 p-3">
              <div className="text-[13px] text-fg">{x.t}</div>
              <div className="mt-0.5 font-mono text-[11px] text-fg-3">{x.s}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AutomationsList({ items, loading, onToggle, onOpen, onNew }: {
  items: ListItem[]
  loading: boolean
  onToggle: (id: number, enabled: boolean) => void
  onOpen: (a: ListItem) => void
  onNew: () => void
}) {
  const activeCount = items.filter(a => a.enabled && a.mode === 'active').length
  const dryCount = items.filter(a => a.enabled && a.mode === 'dryrun').length
  const empty = !loading && items.length === 0
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-4">
        <div>
          <h2 className="text-[15px] font-medium text-fg">Automations</h2>
          <p className={cn('mt-0.5 text-[12px] text-fg-2', !empty && 'font-mono')}>
            {empty
              ? 'Reactive rules that respond to live signals'
              : (
                  <>
                    {activeCount}
                    {' '}
                    active ·
                    {' '}
                    {dryCount}
                    {' '}
                    in dry-run ·
                    {' '}
                    {items.length}
                    {' '}
                    total
                  </>
                )}
          </p>
        </div>
        {!empty && (
          <Button variant="accent" size="sm" onClick={onNew}>
            <Icon.Plus size={14} />
            New automation
          </Button>
        )}
      </div>

      {loading
        ? <div className="px-[18px] py-16 text-center text-[13px] text-fg-3">Loading automations…</div>
        : empty
          ? <EmptyState onNew={onNew} />
          : <div>{items.map(a => <Row key={a.id} a={a} onToggle={onToggle} onOpen={onOpen} />)}</div>}
    </div>
  )
}
