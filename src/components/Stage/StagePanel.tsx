'use client'

import { Minus, Plus, Power, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/src/components/ds'
import { TempControl } from '@/src/components/TempControl/TempControl'
import type { NightPhaseKey } from '@/src/components/TempScreen/nightPhases'
import { HoldDurationRow, HoldStatus } from '@/src/components/TempScreen/TemperatureHoldControls'
import { TempStepper } from '@/src/components/TempScreen/TempStepper'
import type { StepperTab } from '@/src/components/TempScreen/TempStepper'
import type { SideNightPhases } from '@/src/components/TempScreen/useNightPhases'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ControlVariant, TempDisplay } from '@/src/providers/PrefsProvider'
import type { TemperatureControlStatus } from '@/src/temperature/controller'
import type { SideStatus, StageSide } from './stageColors'

export interface StagePanelProps {
  open: boolean
  side: StageSide
  name: string
  /** "Left · In bed", "Both sides"… */
  scope: string
  isOn: boolean
  powerDisabled: boolean
  onPower: () => void
  onClose: () => void
  status: SideStatus
  control: TemperatureControlStatus | undefined
  onResumed: () => void
  controlStyle: ControlVariant
  display: TempDisplay
  unit: TempUnit
  targetF: number
  bedF: number | null
  stepDisabled: boolean
  onPreview: (f: number) => void
  onCommit: (f: number) => void
  onStep: (delta: number) => void
  holdMinutes: number
  onHoldChange: (minutes: number) => void
  stepper: {
    tab: StepperTab
    onTabChange: (tab: StepperTab) => void
    schedule: SideNightPhases
    onStepPhase: (phase: NightPhaseKey, delta: number) => void
  }
}

/**
 * The selected side's controls, floating at the right of the stage between the header
 * and the timeline. Slides in 24px when a side is selected. The control follows the
 * device's Temperature control setting: dial, slider, or Now · Night · Dawn.
 */
export function StagePanel({
  open, side, name, scope, isOn, powerDisabled, onPower, onClose, status, control, onResumed,
  controlStyle, display, unit, targetF, bedF, stepDisabled, onPreview, onCommit, onStep, holdMinutes, onHoldChange, stepper,
}: StagePanelProps) {
  const isStepper = controlStyle === 'stepper'
  return (
    <aside
      role="region"
      aria-label={`${name} controls`}
      aria-hidden={!open}
      data-testid="stage-panel"
      data-open={open}
      className={cn(
        'absolute z-10 flex w-[320px] flex-col gap-4 overflow-y-auto rounded-[14px] border p-5 transition-[transform,opacity] duration-300 ease-standard',
        'right-6 top-[92px] bottom-[254px] max-[899px]:inset-x-3 max-[899px]:top-auto max-[899px]:bottom-[240px] max-[899px]:w-auto max-[899px]:max-h-[52dvh]',
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-6 opacity-0',
      )}
      style={{ background: 'rgba(11,11,12,0.92)', borderColor: '#26262a' }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-[#ececec]">{name}</div>
          <div className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-[#8b8b92]">{scope}</div>
        </div>
        <button
          type="button"
          aria-label={isOn ? `Turn ${name} off` : `Turn ${name} on`}
          aria-pressed={isOn}
          disabled={powerDisabled}
          onClick={onPower}
          className={cn(
            'ml-auto flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border bg-black/20 transition-colors hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-45',
            !isOn ? 'border-[#5d5d63] text-[#8b8b92]' : side === 'left' ? 'border-side-left text-side-left' : 'border-side-right text-side-right',
          )}
        >
          <Power size={16} />
        </button>
        <button type="button" aria-label="Close panel" onClick={onClose} className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8b8b92] hover:bg-white/[0.08] hover:text-[#ececec]">
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: status.color }} data-testid="stage-panel-status">{status.text}</span>
      </div>
      <HoldStatus side={side} control={control} onResumed={onResumed} />

      <div className="flex justify-center">
        {isStepper
          ? (
              <TempStepper
                tab={stepper.tab}
                onTabChange={stepper.onTabChange}
                schedule={stepper.schedule}
                onStepPhase={stepper.onStepPhase}
                unit={unit}
                display={display}
                targetF={targetF}
                bedF={bedF}
                isOn={isOn}
                nowDisabled={stepDisabled}
                onStepNow={onStep}
              />
            )
          : (
              <TempControl
                variant={controlStyle}
                display={display}
                targetF={targetF}
                bedF={bedF}
                unit={unit}
                power={isOn}
                onChange={onPreview}
                onCommit={onCommit}
                statusOverride={isOn ? undefined : 'OFF'}
              />
            )}
      </div>

      {!isStepper && (
        <div className="flex items-center justify-center gap-4">
          <IconButton icon={Minus} size={48} label="Cooler" disabled={stepDisabled} onClick={() => onStep(-1)} />
          <IconButton icon={Plus} size={48} label="Warmer" disabled={stepDisabled} onClick={() => onStep(1)} />
        </div>
      )}

      <HoldDurationRow holdMinutes={holdMinutes} onDurationChange={onHoldChange} />
    </aside>
  )
}
