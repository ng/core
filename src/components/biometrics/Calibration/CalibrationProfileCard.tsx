'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLingui } from '@lingui/react/macro'
import { defaultConfig, type BiometricConfig } from '@/src/biometrics/algorithms/registry-core'
import { STAGE_METRIC_LABELS } from '@/src/lib/sleep-stage-rules'
import { formatMetricValue } from '@/src/components/Settings/sleepStageEditing'
import { Card, CardHeader, Slider } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { aggregate, coverage, PARAMS, readParam, roundParam, stageOverrides, type Actor, type Draft, type NightScore, type ParamPath } from './calibration-model'

export const ACTOR_BADGE: Record<Actor['kind'], { label: string, className: string }> = {
  agent: { label: 'AGENT', className: 'bg-actor-agent-bg text-actor-agent' },
  you: { label: 'YOU', className: 'bg-actor-you-bg text-actor-you' },
  pod: { label: 'POD', className: 'bg-actor-pod-bg text-actor-pod' },
}

export function ActorBadge({ kind }: { kind: Actor['kind'] }) {
  const badge = ACTOR_BADGE[kind]
  return <span className={cn('shrink-0 rounded-tag px-1.5 py-0.5 font-mono text-[10px] tracking-[0.06em]', badge.className)}>{badge.label}</span>
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="border-t border-line pb-1 pt-3 font-mono text-[11px] tracking-[0.08em] text-fg-3">{children}</div>
}

/**
 * The saved profile, value by value against the previous one. Values that
 * differ from previous are white; moving a slider edits a draft of the saved
 * profile that only takes effect through Save and request.
 */
export function ProfileCard({ saved, previous, previousIsDefaults, draft, onDraft, disabled, actor, savedAgo, scores }: {
  saved: BiometricConfig
  previous: BiometricConfig
  previousIsDefaults: boolean
  draft: Draft
  onDraft: (draft: Draft) => void
  disabled?: boolean
  actor: Actor | null
  savedAgo: string | null
  scores: NightScore[]
}) {
  const { t } = useLingui()
  const pathname = usePathname()
  const lang = pathname?.split('/')[1] || 'en'
  const set = (path: ParamPath, value: number) => onDraft({ ...draft, [path]: roundParam(path, value) })

  // What the saved profile did on the most trusted split that ran.
  const split = (['holdout', 'validation', 'tuning'] as const).find(s => aggregate(scores, 'heart_rate', s).nights > 0)
  const effect = (paths: ParamPath[], metric: 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1', unit: string) => {
    if (paths.every(p => draft[p] === readParam(previous, p))) return t`unchanged`
    if (paths.some(p => draft[p] !== readParam(saved, p))) return t`tested on save`
    if (!split) return t`not tested`
    const a = aggregate(scores, metric, split)
    if (a.previous === null || a.saved === null) return t`not tested`
    const delta = a.saved - a.previous
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
    const covered = metric === 'heart_rate' ? coverage(scores.filter(s => s.split === split)).saved : null
    return `${split} ${sign}${Math.abs(delta).toFixed(1)} ${unit}${covered === null ? '' : ` · ${t`covered`} ${Math.round(covered * 100)}%`}`
  }
  const tone = (path: ParamPath) => draft[path] === readParam(previous, path) ? 'text-fg-2' : 'text-fg'
  const fmt = (path: ParamPath) => String(draft[path])
  const sub = (path: ParamPath) => `${PARAMS[path].key} · ${t`previous`}: ${readParam(previous, path)} · ${t`range`} ${PARAMS[path].min}–${PARAMS[path].max}`

  // Overrides are counted against the shipped rules the Sleep stages page starts from.
  const stages = stageOverrides(defaultConfig.sleep_stages, saved.sleep_stages)
  const count = stages.overrides.length + (stages.fallbackChanged ? 1 : 0)

  const row = (label: ReactNode, sublines: ReactNode, control: ReactNode, effectText: string, divider = false) => (
    <div className={cn('grid items-center gap-x-4 gap-y-2 py-2 @min-[640px]:grid-cols-[minmax(0,1fr)_170px_150px]', divider && 'border-t border-line')}>
      <div className="text-sm leading-[1.7]">
        {label}
        <div className="text-xs text-fg-3">{sublines}</div>
      </div>
      <div className="flex flex-col gap-3">{control}</div>
      <div className="font-mono text-xs text-fg-2 @min-[640px]:text-right">{effectText}</div>
    </div>
  )
  const value = (path: ParamPath, suffix = '') => <span className={cn('font-mono text-[13px]', tone(path))}>{`${fmt(path)}${suffix}`}</span>
  const slider = (path: ParamPath, label: string) => (
    <Slider value={draft[path]} min={PARAMS[path].min} max={PARAMS[path].max} step={PARAMS[path].step} label={label} disabled={disabled} onChange={v => set(path, v)} />
  )

  const tol = 'heart_rate.trackingToleranceBpm', hist = 'heart_rate.trackingHistoryLength'
  const low = 'breathing_rate.intervalLowerRatio', high = 'breathing_rate.intervalUpperRatio', windows = 'hrv_index.minimumWindows'

  return (
    <Card className="gap-2.5">
      <CardHeader
        title={t`Saved profile against previous`}
        subtitle={previousIsDefaults
          ? t`Changed values are white; the previous profile (System defaults) sits underneath. Moving a control edits the saved profile; saving again re-requests it. The processor adopts a profile only after it acknowledges a request.`
          : t`Changed values are white; the previous profile sits underneath. Moving a control edits the saved profile; saving again re-requests it. The processor adopts a profile only after it acknowledges a request.`}
        right={actor && savedAgo
          ? (
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-2">
                <ActorBadge kind={actor.kind} />
                {actor.kind === 'agent' ? `${actor.name} · ${savedAgo}` : savedAgo}
              </span>
            )
          : <span className="whitespace-nowrap text-xs text-fg-2">{t`System defaults`}</span>}
      />

      <Eyebrow>{t`HEART RATE`}</Eyebrow>
      {row(
        <>
          {t`Accept an estimate when it is within`}
          {' '}
          {value(tol)}
          {' '}
          {t`bpm of the tracker`}
        </>,
        sub(tol), slider(tol, t`Tracking tolerance (bpm)`), effect([tol], 'heart_rate', 'bpm'),
      )}
      {row(
        <>
          {t`Keep the last`}
          {' '}
          {value(hist)}
          {' '}
          {t`accepted estimates in the tracker`}
        </>,
        sub(hist), slider(hist, t`Tracking history length`), effect([hist], 'heart_rate', 'bpm'), true,
      )}

      <Eyebrow>{t`BREATHING`}</Eyebrow>
      {row(
        <>
          {t`Reject intervals shorter than`}
          {' '}
          {value(low, '×')}
          {' '}
          {t`or longer than`}
          {' '}
          {value(high, '×')}
          {' '}
          {t`the median`}
        </>,
        `${PARAMS[low].key} ${PARAMS[low].min}–${PARAMS[low].max} · ${PARAMS[high].key} ${PARAMS[high].min}–${PARAMS[high].max} · ${t`previous`}: ${readParam(previous, low)} / ${readParam(previous, high)}`,
        <>
          {slider(low, t`Shortest breathing interval (× median)`)}
          {slider(high, t`Longest breathing interval (× median)`)}
        </>,
        effect([low, high], 'breathing_rate', 'br/m'),
      )}

      <Eyebrow>{t`HRV INDEX`}</Eyebrow>
      {row(
        <>
          {t`Report the index only after`}
          {' '}
          {value(windows)}
          {' '}
          {t`accepted 10-second IBI windows`}
        </>,
        `${sub(windows)} · ${t`window IBI variability, not clinical RMSSD`}`,
        slider(windows, t`Minimum IBI windows`), effect([windows], 'window_ibi_variability_v1', 'ms'),
      )}

      <Eyebrow>{t`SLEEP STAGES`}</Eyebrow>
      <div className="flex items-center gap-3 py-2 text-sm">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span>
            {t`Inherits the ${stages.ruleCount} rules and fallback from`}
            {' '}
            <Link href={`/${lang}/settings?section=sleep-stages`} className="text-link hover:underline">{t`Sleep stages`}</Link>
            {count === 1 ? t`, with 1 override` : t`, with ${count} overrides`}
          </span>
          {stages.restructured && <span className="text-[13px] text-fg-2">{t`The rule list itself differs from the shipped rules.`}</span>}
          {stages.overrides.map(o => (
            <span key={`${o.rule}:${o.metric}:${o.op}`} className="text-[13px] text-fg-2">
              {t`Rule ${o.rule}`}
              {' · '}
              {`${o.stage[0].toUpperCase()}${o.stage.slice(1)} ${t`when`} ${STAGE_METRIC_LABELS[o.metric].toLowerCase()} ${o.op} `}
              <span className="font-mono line-through">{formatMetricValue(o.metric, o.before)}</span>
              {' '}
              <span className="font-mono text-fg">{formatMetricValue(o.metric, o.after)}</span>
            </span>
          ))}
          {stages.fallbackChanged && (
            <span className="text-[13px] text-fg-2">
              {t`Fallback`}
              {' '}
              <span className="font-mono line-through">{defaultConfig.sleep_stages.engine === 'rules' ? defaultConfig.sleep_stages.ruleset.fallback : ''}</span>
              {' '}
              <span className="font-mono text-fg">{saved.sleep_stages.engine === 'rules' ? saved.sleep_stages.ruleset.fallback : ''}</span>
            </span>
          )}
        </div>
        <Link href={`/${lang}/settings?section=sleep-stages`} className="ml-auto whitespace-nowrap text-[13px] text-fg-2 hover:text-fg">{t`Edit overrides`}</Link>
      </div>
    </Card>
  )
}
