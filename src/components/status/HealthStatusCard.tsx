'use client'

import { ChevronRight, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Card, StatusDot, type Tone } from '@/src/components/ds'

// ─── Types ────────────────────────────────────────────────────────────

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

interface ServiceItem {
  name: string
  description?: string
  status: ServiceStatus
  detail?: string
}

interface HealthStatusCardProps {
  /** Category title */
  title: string
  /** Short subtitle */
  description: string
  /** Lucide icon component */
  icon: LucideIcon
  /** Accent color for the icon (Tailwind text color class) */
  iconColor: string
  /** Background tint for the icon (Tailwind bg color class) */
  iconBg: string
  /** Individual services/checks in this category */
  services: ServiceItem[]
  /** Whether data is loading */
  isLoading?: boolean
  /** Additional content to render when expanded (e.g. upcoming jobs) */
  expandedContent?: React.ReactNode
  /** Optional callback when header is clicked (overrides default expand behavior) */
  onHeaderClick?: () => void
  /** Start expanded (desktop dashboards have room to show all detail). */
  defaultExpanded?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────

const STATUS_TONE: Record<ServiceStatus, Tone> = {
  ok: 'ok',
  degraded: 'warn',
  error: 'danger',
  unknown: 'muted',
}

// ─── Component ────────────────────────────────────────────────────────

export function HealthStatusCard({
  title,
  description,
  icon: Icon,
  iconColor,
  iconBg,
  services,
  isLoading,
  expandedContent,
  onHeaderClick,
  defaultExpanded = false,
}: HealthStatusCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const healthyCount = services.filter(s => s.status === 'ok').length
  const totalCount = services.length
  const allHealthy = healthyCount === totalCount

  return (
    <Card>
      {/* Header — always visible, tap to expand */}
      <button
        type="button"
        aria-expanded={isExpanded}
        className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left text-fg"
        onClick={() => onHeaderClick ? onHeaderClick() : setIsExpanded(prev => !prev)}
      >
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-ctl', iconBg)}>
          <Icon size={15} className={iconColor} />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">{title}</p>
          <p className="truncate text-[13px] text-fg-2">{description}</p>
        </div>

        {isLoading
          ? <span className="font-mono text-xs text-fg-2">…</span>
          : (
              <span className={cn('flex items-center gap-1.5 font-mono text-xs', allHealthy ? 'text-ok' : 'text-warn')}>
                <StatusDot tone={allHealthy ? 'ok' : 'warn'} />
                {`${healthyCount}/${totalCount}`}
              </span>
            )}

        <ChevronRight
          size={14}
          className={cn('shrink-0 text-fg-3 transition-transform duration-150', isExpanded && 'rotate-90')}
        />
      </button>

      {/* Expanded service rows */}
      {isExpanded && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          {services.map(service => (
            <div key={service.name} className="flex items-start gap-2.5">
              <StatusDot tone={STATUS_TONE[service.status]} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px]">{service.name}</p>
                {service.detail && (
                  <p className="truncate font-mono text-[11px] text-fg-3">{service.detail}</p>
                )}
              </div>
              {service.description && (
                <span className="max-w-[55%] truncate font-mono text-xs text-fg-2">{service.description}</span>
              )}
            </div>
          ))}

          {expandedContent && (
            <div className="border-t border-line pt-3">
              {expandedContent}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
