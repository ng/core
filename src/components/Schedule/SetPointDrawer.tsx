'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Plus } from 'lucide-react'
import { CurveChart } from './CurveChart'
import { SetPointCard } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'
import { useSchedules } from '@/src/hooks/useSchedules'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import { DAYS } from './DaySelector'
import type { DayOfWeek } from './DaySelector'
import type { CurvePoint } from '@/src/lib/sleepCurve/types'
import { timeStringToMinutes } from '@/src/lib/sleepCurve/generate'

interface SetPointDrawerProps {
  open: boolean
  onClose: () => void
  selectedDay: DayOfWeek
  /** All selected days (for group editing context) */
  selectedDays?: Set<DayOfWeek>
}

/**
 * Full-screen drawer for editing set points.
 * - Chart pinned at top showing the curve with interactive dots
 * - Set points scroll vertically below
 * - Tap a dot → scroll to and highlight that row
 * - Tap a row → highlight corresponding dot on chart
 */
export function SetPointDrawer({ open, onClose, selectedDay, selectedDays }: SetPointDrawerProps) {
  const {
    phases,
    isLoading,
    createSetPoint,
    updateSetPoint,
    adjustTemperature,
    deleteSetPoint,
    isMutating,
  } = useSchedules(selectedDay)

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingPhase, setEditingPhase] = useState<SchedulePhase | null>(null)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  // Convert phases to CurvePoints for chart
  const curveData = (() => {
    if (phases.length === 0) return null

    const temps = phases.map(p => p.temperature)
    const min = Math.min(...temps)
    const max = Math.max(...temps)
    const btMin = timeStringToMinutes(phases[0].time)

    const points: CurvePoint[] = phases.map((p, i) => {
      let tMin = timeStringToMinutes(p.time) - btMin
      if (tMin < -120) tMin += 24 * 60

      const frac = phases.length > 1 ? i / (phases.length - 1) : 0
      const phase = frac < 0.1 ? 'warmUp' as const
        : frac < 0.25 ? 'coolDown' as const
          : frac < 0.55 ? 'deepSleep' as const
            : frac < 0.75 ? 'maintain' as const
              : frac < 0.9 ? 'preWake' as const
                : 'wake' as const

      return { minutesFromBedtime: tMin, tempOffset: p.temperature - 80, phase }
    }).sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

    return { points, bedtimeMinutes: btMin, minTempF: min, maxTempF: max }
  })()

  // When a dot is tapped on the chart, scroll to that row
  const handleChartSelect = useCallback((index: number) => {
    setSelectedIndex(index)
    const el = rowRefs.current.get(index)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // When a row is tapped, highlight it on the chart
  const handleRowTap = useCallback((phase: SchedulePhase, index: number) => {
    setSelectedIndex(index)
    setEditingPhase(phase)
    setEditorOpen(true)
  }, [])

  const handleAddNew = useCallback(() => {
    setEditingPhase(null)
    setEditorOpen(true)
  }, [])

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false)
    setEditingPhase(null)
  }, [])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div>
          <span className="text-sm font-medium text-white">Set Points</span>
          {selectedDays && selectedDays.size > 0 && (
            <span className="ml-2 text-xs text-zinc-500">
              {Array.from(selectedDays).map(d => DAYS.find(x => x.key === d)?.label).join(', ')}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-sky-400 transition-colors hover:bg-sky-500/10 active:bg-sky-500/20"
        >
          Done
        </button>
      </div>

      {/* Pinned chart */}
      {curveData && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <CurveChart
            points={curveData.points}
            bedtimeMinutes={curveData.bedtimeMinutes}
            minTempF={curveData.minTempF}
            maxTempF={curveData.maxTempF}
            selectedIndex={selectedIndex}
            onSelectIndex={handleChartSelect}
            compact
          />
        </div>
      )}

      {/* Scrollable set point list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
          </div>
        ) : phases.length === 0 ? (
          <p className="py-8 text-center text-xs text-zinc-600">
            No temperature set points configured
          </p>
        ) : (
          <div className="space-y-1.5">
            {phases.map((phase, index) => (
              <div
                key={phase.id}
                ref={(el) => { if (el) rowRefs.current.set(index, el); else rowRefs.current.delete(index) }}
                className={
                  selectedIndex === index
                    ? 'rounded-xl ring-1 ring-sky-500/50'
                    : ''
                }
              >
                <SetPointCard
                  phase={phase}
                  onAdjustTemp={adjustTemperature}
                  onDelete={deleteSetPoint}
                  onTapCard={(p) => handleRowTap(p, index)}
                  disabled={isMutating}
                />
              </div>
            ))}
          </div>
        )}

        {/* Add button */}
        <button
          onClick={handleAddNew}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:border-sky-500 active:text-sky-400"
        >
          <Plus size={14} />
          Add Set Point
        </button>
      </div>

      {/* Editor */}
      <SetPointEditor
        editingPhase={editingPhase}
        open={editorOpen}
        onClose={handleCloseEditor}
        onCreate={createSetPoint}
        onUpdate={updateSetPoint}
        onDelete={deleteSetPoint}
      />
    </div>
  )
}
