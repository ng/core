'use client'

import { useCallback, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, InlineError, PageHeader, SectionLabel, SegmentedControl, Skeleton, StatusDot } from '@/src/components/ds'
import { useSchedule } from '@/src/hooks/useSchedule'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { useSide } from '@/src/providers/SideProvider'
import type { SideSelection } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { groupDaysBySharedCurve } from '@/src/lib/scheduleGrouping'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import { getCurrentDay, type DayOfWeek } from '@/src/lib/scheduleTime'
import { CurveCard } from './CurveCard'
import { CurveEditor } from './CurveEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { AlarmSection } from './AlarmSection'

interface EditingCurve {
  days: DayOfWeek[]
  setPoints: Array<{ time: string, temperature: number }>
}

/**
 * Schedule screen: the curve running today as a large chart, the other
 * curves (groups of days sharing a temperature schedule) below, and alarms
 * in the context column. Creating/editing a curve swaps in `CurveEditor`.
 */
export function SchedulePage() {
  const { primarySide: side, selectedSide, selectSide } = useSide()
  const {
    confirmMessage,
    isPowerEnabled,
    isGlobalEnabled,
    isApplying,
    isMutating,
    toggleGlobalSchedules,
    deleteCurve,
    setSelectedDays,
    isLoading: hookLoading,
  } = useSchedule()

  const { nextEvent } = useScheduleActive()
  const { leftName, rightName } = useSideNames()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })

  const [editor, setEditor] = useState<EditingCurve | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ days: DayOfWeek[], label: string } | null>(null)

  // Recompute each render — React Compiler's lint (react-hooks/
  // preserve-manual-memoization) objects to the previous useMemo here
  // because it can't match the manual memo to its own plan. The
  // computation is cheap relative to the tRPC fetch that precedes it.
  const groups: ScheduleGroup[] = data?.temperature
    ? groupDaysBySharedCurve(data.temperature)
    : []

  // Curves to render: ones with set points OR explicitly paused
  const visibleGroups = groups.filter(g => g.setPoints.length > 0 || g.allDisabled)
  const hasAnyCurves = visibleGroups.length > 0

  // The "active" curve = the one whose days include today; gets the
  // next-event annotation since that's what's actually running.
  const activeCurveKey = useMemo(() => {
    if (!isPowerEnabled) return null
    const today = getCurrentDay()
    return visibleGroups.find(g => g.days.includes(today) && g.setPoints.length > 0)?.key ?? null
  }, [visibleGroups, isPowerEnabled])

  // Large chart card: today's curve, else the first curve with set points.
  const featured = visibleGroups.find(g => g.key === activeCurveKey)
    ?? visibleGroups.find(g => g.setPoints.length > 0 && !g.allDisabled)
    ?? null
  const others = visibleGroups.filter(g => g !== featured)

  const openEditor = useCallback((next: EditingCurve) => {
    setEditor(next)
    window.scrollTo?.({ top: 0 })
  }, [])

  const handleEdit = useCallback((group: ScheduleGroup) => {
    openEditor({ days: group.days, setPoints: group.setPoints })
    setSelectedDays(new Set(group.days))
  }, [openEditor, setSelectedDays])

  const handleCreate = useCallback(() => {
    openEditor({ days: [], setPoints: [] })
  }, [openEditor])

  const handleDelete = useCallback((group: ScheduleGroup) => {
    const labelDays = group.days.length === 7
      ? 'every day'
      : group.days.length === 1
        ? group.days[0]
        : `${group.days.length} days`
    setPendingDelete({ days: group.days, label: labelDays })
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    try {
      await deleteCurve(pendingDelete.days)
    }
    finally {
      setPendingDelete(null)
    }
  }, [pendingDelete, deleteCurve])

  if (editor) {
    return (
      <CurveEditor
        onClose={() => setEditor(null)}
        initialDays={editor.days}
        initialSetPoints={editor.setPoints}
      />
    )
  }

  const sideOptions: Array<{ value: SideSelection, label: string }> = [
    { value: 'left', label: leftName },
    { value: 'right', label: rightName },
    { value: 'both', label: 'Both' },
  ]
  const sideLabel = selectedSide === 'both' ? 'both sides' : selectedSide === 'left' ? leftName : rightName

  return (
    <>
      <PageHeader
        title="Schedule"
        middle={(
          <div className="hidden min-[900px]:block">
            <SegmentedControl ariaLabel="Side" options={sideOptions} value={selectedSide} onChange={selectSide} />
          </div>
        )}
        right={(
          <>
            <ScheduleToggle
              enabled={isGlobalEnabled}
              onToggle={() => void toggleGlobalSchedules()}
              isLoading={isMutating || hookLoading}
            />
            <Button icon={Plus} onClick={handleCreate} className="hidden min-[900px]:inline-flex">
              New curve
            </Button>
          </>
        )}
      />

      <SegmentedControl
        full
        ariaLabel="Side"
        className="min-[900px]:hidden"
        options={sideOptions}
        value={selectedSide}
        onChange={selectSide}
      />

      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      <div className="grid gap-3.5 min-[900px]:gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3.5 min-[900px]:gap-4">
          <SectionLabel className="mt-1 min-[900px]:hidden">Curves</SectionLabel>

          {error && (
            <Card>
              <InlineError>
                Failed to load schedules:
                {' '}
                {error.message}
              </InlineError>
            </Card>
          )}

          {isLoading && !data && <Skeleton className="h-[140px] min-[900px]:h-[380px]" />}

          {!isLoading && !error && !hasAnyCurves && (
            <Card dashed className="items-center py-8 text-center">
              <span className="text-[15px] font-medium">No schedule yet</span>
              <span className="text-[13px] text-fg-2">
                Create a sleep curve to automatically control bed temperature
              </span>
              <Button variant="primary" icon={Plus} onClick={handleCreate}>
                Create sleep curve
              </Button>
            </Card>
          )}

          {featured && (
            <CurveCard
              featured
              group={featured}
              onEdit={() => handleEdit(featured)}
              onDelete={() => handleDelete(featured)}
              isActive={featured.key === activeCurveKey}
              nextEvent={featured.key === activeCurveKey ? nextEvent : null}
            />
          )}

          {hasAnyCurves && (
            <div className="grid gap-3.5 min-[900px]:grid-cols-3 min-[900px]:gap-3">
              {others.map(group => (
                <CurveCard
                  key={group.key}
                  group={group}
                  onEdit={() => handleEdit(group)}
                  onDelete={() => handleDelete(group)}
                />
              ))}
              <Button
                variant="dashed"
                icon={Plus}
                onClick={handleCreate}
                className="h-11 rounded-card text-sm min-[900px]:h-auto min-[900px]:min-h-[108px] min-[900px]:text-[13px]"
              >
                Create curve
              </Button>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <AlarmSection side={side} selectedSide={selectedSide} />
          <SchedulerStatus sideLabel={sideLabel} />
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete curve?"
        message={`This will remove the schedule for ${pendingDelete?.label ?? ''}. The Pod won't change temperature on those days until you create a new curve.`}
        confirmLabel="Delete"
        variant="danger"
        busy={isMutating}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

/** Footer: scheduler drift status from health.system (shared with the sidebar's query). */
function SchedulerStatus({ sideLabel }: { sideLabel: string }) {
  const { data } = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const scheduler = data?.scheduler
  const drifted = scheduler?.drift?.drifted ?? false

  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3 font-mono text-xs text-fg-2 @min-[960px]:mt-auto">
      {scheduler && (
        <div className="flex items-center gap-2">
          <StatusDot tone={!scheduler.enabled ? 'muted' : drifted ? 'warn' : 'ok'} />
          {!scheduler.enabled
            ? 'Scheduler off'
            : `Scheduler ${drifted ? 'out of sync' : 'in sync'} · ${scheduler.jobCount} job${scheduler.jobCount === 1 ? '' : 's'}`}
        </div>
      )}
      <div>{`Applies to ${sideLabel} · edits apply on save`}</div>
    </div>
  )
}
