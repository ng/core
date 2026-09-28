/**
 * Diagnostics / status panel — live Autopilot state and the audit trail. Global
 * kill-switch, a per-rule card (status, last fire, fires today, dry-run toggle),
 * and the run log: every evaluation that mattered, which is the transparency
 * Eight Sleep's black box lacks.
 */
'use client'

import { cn } from '@/lib/utils'
import { Icon } from './icons'
import { Badge, Card, SideBadge, StatusBadge, Toggle } from './primitives'
import { formatSetpointF } from '@/src/lib/tempUtils'

export interface RuleStatus {
  id: number
  name: string
  enabled: boolean
  dryRun: boolean
  side: 'left' | 'right' | null
  cooldownMin: number | null
  lastOutcome: string | null
  lastFiredAt: Date | string | null
  firesToday: number
}

export interface RunRow {
  id: number
  automationId: number
  ruleName: string | null
  firedAt: Date | string
  outcome: 'fired' | 'skipped' | 'clamped' | 'dry_run' | 'error'
  detail: unknown
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d)
}

function ago(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - toDate(d).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function hhmm(d: Date | string): string {
  const x = toDate(d)
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`
}

function statusMode(r: RuleStatus): 'active' | 'dryrun' | 'paused' {
  if (!r.enabled) return 'paused'
  return r.dryRun ? 'dryrun' : 'active'
}

function verdictTone(v: RunRow['outcome']): 'red' | 'zinc' | 'amber' {
  if (v === 'fired' || v === 'clamped') return 'red'
  if (v === 'dry_run') return 'amber'
  return 'zinc'
}

interface ActionDetail { kind?: string, side?: string, temp?: number, on?: boolean, sent?: boolean, dryRun?: boolean, clamped?: boolean, antiThrash?: boolean, skipped?: string, notified?: boolean }
function actionText(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return ''
  const d = detail as { actions?: ActionDetail[], reason?: string }
  if (d.reason) return d.reason.replace(/-/g, ' ')
  const a = d.actions?.[0]
  if (!a) return ''
  if (a.kind === 'notify') return 'notify'
  if (a.kind === 'setPower') return `power ${a.on ? 'on' : 'off'}`
  if (a.kind === 'setTemperature') {
    if (a.skipped) return a.skipped.replace(/-/g, ' ')
    const verb = a.sent ? 'set' : a.dryRun ? 'would set' : a.antiThrash ? 'held' : 'set'
    return a.temp != null ? `${verb} ${formatSetpointF(a.temp, 'F')}${a.clamped ? ' (clamped)' : ''}` : verb
  }
  return a.kind ?? ''
}

function RuleStatusCard({ a, onDry }: { a: RuleStatus, onDry: (id: number, dryRun: boolean) => void }) {
  return (
    <Card className="px-[18px] py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{a.name}</span>
            <SideBadge side={a.side} />
          </div>
          <div className="mt-1"><StatusBadge mode={statusMode(a)} /></div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-fg-2">
          <Toggle size="sm" label="Dry-run" checked={a.dryRun} onChange={() => onDry(a.id, !a.dryRun)} />
          dry-run
        </label>
      </div>

      <div className="rounded-ctl border border-line bg-code p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="sp-label">Last outcome</span>
          <span className="truncate font-mono text-[13px] text-fg">{a.lastOutcome ?? '—'}</span>
        </div>
        <div className="mt-1 font-mono text-[11px] text-fg-3">{a.cooldownMin ? `cooldown ${a.cooldownMin}m` : 'no cooldown'}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="sp-label">Last fired</div>
          <div className="font-mono text-fg">{ago(a.lastFiredAt)}</div>
        </div>
        <div>
          <div className="sp-label">Today</div>
          <div className="font-mono text-fg">
            {a.firesToday}
            {' '}
            fire
            {a.firesToday === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </Card>
  )
}

function RunLog({ runs }: { runs: RunRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-[18px] py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Icon.List size={14} className="text-icon" />
          <span className="text-[15px] font-medium text-fg">Run log</span>
          <span className="text-[12px] text-fg-3">every evaluation that mattered</span>
        </div>
        <Badge tone="zinc">AUDIT TRAIL</Badge>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full min-w-[520px] text-left">
          <thead className="sticky top-0 bg-surface">
            <tr className="sp-label">
              <th className="px-[18px] py-2 font-normal">Time</th>
              <th className="px-2 py-2 font-normal">Rule</th>
              <th className="px-2 py-2 font-normal">Verdict</th>
              <th className="px-[18px] py-2 font-normal">Action / reason</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={4} className="px-[18px] py-8 text-center text-[13px] text-fg-3">No evaluations recorded yet.</td></tr>
            )}
            {runs.map(r => (
              <tr key={r.id} className="border-t border-line hover:bg-active">
                <td className="whitespace-nowrap px-[18px] py-2.5 font-mono text-[12px] text-fg-2">{hhmm(r.firedAt)}</td>
                <td className="px-2 py-2.5 text-[13px] text-fg">{r.ruleName ?? `#${r.automationId}`}</td>
                <td className="px-2 py-2.5"><Badge tone={verdictTone(r.outcome)} dot={r.outcome === 'fired'}>{r.outcome.replace('_', '-').toUpperCase()}</Badge></td>
                <td className={cn('whitespace-nowrap px-[18px] py-2.5 font-mono text-[12px]', r.outcome === 'fired' ? 'text-cool' : 'text-fg-3')}>{actionText(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function StatusPanel({ globalEnabled, onKill, rules, runs, loading, onDry }: {
  globalEnabled: boolean
  onKill: (enabled: boolean) => void
  rules: RuleStatus[]
  runs: RunRow[]
  loading: boolean
  onDry: (id: number, dryRun: boolean) => void
}) {
  const killed = !globalEnabled
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className={cn('flex items-center gap-3 px-[18px] py-3.5', killed && 'border-danger-line')}>
        <Icon.Power size={16} className={killed ? 'text-danger' : 'text-icon'} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{killed ? 'Autopilot halted' : 'Autopilot running'}</div>
          <div className="text-[12px] text-fg-2">{killed ? 'All rules suspended' : 'Global kill-switch · live state & audit trail'}</div>
        </div>
        <Toggle size="md" label="Autopilot enabled" checked={!killed} onChange={() => onKill(killed)} />
      </Card>

      {killed && (
        <div className="flex items-center gap-2 rounded-ctl border border-danger-line px-4 py-2.5 text-[13px] text-danger">
          <Icon.AlertTri size={15} className="shrink-0" />
          Kill-switch engaged — no rule will command hardware. Manual control only.
        </div>
      )}
      {loading
        ? <div className="py-16 text-center text-[13px] text-fg-3">Loading status…</div>
        : (
            <>
              {rules.length > 0 && (
                <div className="grid gap-3 @min-[640px]:grid-cols-2 @min-[1000px]:grid-cols-3">
                  {rules.map(a => <RuleStatusCard key={a.id} a={a} onDry={onDry} />)}
                </div>
              )}
              <RunLog runs={runs} />
            </>
          )}
    </div>
  )
}
