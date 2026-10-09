'use client'

import { Box, LayoutGrid } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TempView } from './stagePrefs'

const SEGMENTS: { view: TempView, label: string, icon: LucideIcon }[] = [
  { view: 'cards', label: 'Cards', icon: LayoutGrid },
  { view: 'stage', label: 'Stage', icon: Box },
]

/**
 * Cards | Stage: the Temperature page's view switch, drawn the same in both views
 * (one stage pill split into two segments) so it reads as a mode, not an action.
 */
export function ViewSwitch({ view, onChange, className }: { view: TempView, onChange: (view: TempView) => void, className?: string }) {
  return (
    <div
      role="group"
      aria-label="View"
      data-testid="view-switch"
      className={cn('flex h-[34px] shrink-0 items-stretch overflow-hidden rounded-full border border-[#26262a] p-px', className)}
      style={{ background: 'rgba(11,11,12,0.7)' }}
    >
      {SEGMENTS.map(({ view: v, label, icon: Icon }) => {
        const active = v === view
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(v)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-full px-3.5 text-[13px] transition-colors',
              active ? 'bg-[#ececec] text-[#0b0b0c]' : 'bg-transparent text-[#b0b0b6] hover:bg-[#17171a]',
            )}
          >
            <Icon size={14} />
            {label}
          </button>
        )
      })}
    </div>
  )
}
