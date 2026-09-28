'use client'

import { useState } from 'react'
import { Activity, Fingerprint, Info, Play, RefreshCw, Thermometer, type LucideIcon } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Alert, Button, InlineError, KeyValue, Modal, SegmentedControl, Skeleton } from '@/src/components/ds'
import { cn } from '@/lib/utils'

type SensorType = 'piezo' | 'capacitance' | 'temperature'
type Side = 'left' | 'right'

interface CalibrationProfile {
  id: number
  side: string
  sensorType: string
  status: string
  qualityScore: number | null
  samplesUsed: number | null
  createdAt: Date
  expiresAt: Date | null
  errorMessage: string | null
}

const SENSORS: { type: SensorType, label: string, icon: LucideIcon, iconClassName: string }[] = [
  { type: 'piezo', label: 'Piezo', icon: Activity, iconClassName: 'text-stage-rem' },
  { type: 'capacitance', label: 'Capacitance', icon: Fingerprint, iconClassName: 'text-cool' },
  { type: 'temperature', label: 'Temperature', icon: Thermometer, iconClassName: 'text-warm' },
]

export function qualityTone(score: number | null): string {
  if (score === null) return 'text-fg-2'
  if (score >= 0.8) return 'text-ok'
  if (score >= 0.5) return 'text-warn'
  return 'text-danger'
}

export function qualityLabel(score: number | null): string {
  if (score === null) return '--'
  return `${(score * 100).toFixed(0)}%`
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '--'
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Calibration dialog (sheet on phones), per side: status of each sensor's
 * calibration with a Run button, plus a full recalibration.
 */
export function CalibrationModal({ open, onClose }: { open: boolean, onClose: () => void }) {
  const { side: contextSide } = useSide()
  const { leftName, rightName } = useSideNames()
  const [pickedSide, setPickedSide] = useState<Side | null>(null)
  const side = pickedSide ?? contextSide
  const utils = trpc.useUtils()
  const [triggeringType, setTriggeringType] = useState<SensorType | null>(null)

  const { data: status, isLoading: statusLoading } = trpc.calibration.getStatus.useQuery(
    { side },
    { refetchInterval: 5000, enabled: open },
  )

  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggeringType(null)
    },
    onError: () => setTriggeringType(null),
  })

  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => utils.calibration.getStatus.invalidate(),
  })

  const handleTrigger = (type: SensorType) => {
    setTriggeringType(type)
    triggerSingle.mutate({ side, sensorType: type })
  }

  const isActive = (p: CalibrationProfile | null | undefined) => p?.status === 'running' || p?.status === 'pending'
  const isAnyActive = !!status && SENSORS.some(s => isActive(status[s.type] as CalibrationProfile | null))

  const feedback = triggerSingle.data?.message || triggerFull.data?.message
  const error = triggerSingle.error?.message || triggerFull.error?.message

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Calibration"
      icon={RefreshCw}
      iconClassName="text-warm"
      width={560}
      headerRight={(
        <SegmentedControl
          ariaLabel="Calibration side"
          value={side}
          options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
          onChange={setPickedSide}
        />
      )}
      footer={(
        <div className="ml-auto flex gap-2.5">
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={RefreshCw}
            onClick={() => triggerFull.mutate({})}
            disabled={triggerFull.isPending || isAnyActive}
          >
            Recalibrate all
          </Button>
        </div>
      )}
    >
      <div className="flex items-center gap-2.5 text-[13px] text-fg-2">
        <Info size={14} className="shrink-0" />
        Keep the bed empty while a sensor calibrates.
      </div>

      {feedback && <p className="text-[13px] text-ok">{feedback}</p>}
      {error && <Alert tone="danger">{error}</Alert>}

      {statusLoading
        ? <Skeleton className="h-[260px]" />
        : SENSORS.map(({ type, label, icon: Icon, iconClassName }) => {
            const profile = status?.[type] as CalibrationProfile | null | undefined
            const active = isActive(profile)
            const isTriggering = triggeringType === type
            return (
              <div key={type} className="flex flex-col gap-2.5 rounded-[10px] border border-line px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <Icon size={16} className={iconClassName} />
                  <span className="text-sm font-medium">{label}</span>
                  <span className="ml-auto">
                    {active
                      ? (
                          <span className="font-mono text-[11px] tracking-[0.06em] text-warn">
                            {profile?.status === 'running' ? 'RUNNING' : 'PENDING'}
                          </span>
                        )
                      : (
                          <Button icon={Play} onClick={() => handleTrigger(type)} disabled={isTriggering}>
                            {isTriggering ? 'Queuing…' : 'Run'}
                          </Button>
                        )}
                  </span>
                </div>
                {active
                  ? (
                      <>
                        <div className="h-1.5 overflow-hidden rounded-[3px] bg-line">
                          <div className={cn('h-1.5 w-1/3 rounded-[3px] bg-warn', profile?.status === 'running' && 'animate-pulse')} />
                        </div>
                        <span className="text-xs text-fg-2">
                          {profile?.status === 'running' ? 'Calibrating — this takes a few minutes' : 'Queued — starts within 10 seconds'}
                        </span>
                      </>
                    )
                  : profile
                    ? (
                        <div className="grid grid-cols-2 gap-2.5 min-[480px]:grid-cols-4">
                          <KeyValue label="Quality" value={qualityLabel(profile.qualityScore)} valueClassName={qualityTone(profile.qualityScore)} />
                          <KeyValue label="Samples" value={profile.samplesUsed != null ? profile.samplesUsed.toLocaleString() : '--'} />
                          <KeyValue label="Calibrated" value={formatDate(profile.createdAt)} />
                          <KeyValue label="Expires" value={formatDate(profile.expiresAt)} />
                        </div>
                      )
                    : <span className="text-xs text-fg-2">Not calibrated</span>}
                {profile?.errorMessage && (
                  <InlineError className="line-clamp-2 text-xs">{profile.errorMessage}</InlineError>
                )}
              </div>
            )
          })}
    </Modal>
  )
}
