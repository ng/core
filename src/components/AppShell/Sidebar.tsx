'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { Toggle } from '@/src/components/ds/forms'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { trpc } from '@/src/utils/trpc'
import { activeNavId, langFromPath, NAV_ITEMS } from './navItems'

const noopSubscribe = () => () => {}

const POD_NAMES: Record<string, string> = { H00: 'Pod 3', I00: 'Pod 4', J00: 'Pod 5' }

/** Desktop navigation rail (≥ 900px). */
export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)
  const { developer, setDeveloper } = usePrefs()

  const status = trpc.device.getStatus.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const health = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const version = trpc.system.getVersion.useQuery({}, { staleTime: 60_000 })

  const podName = status.data?.podVersion ? POD_NAMES[status.data.podVersion] ?? status.data.podVersion : 'Pod'
  const healthy = health.data ? health.data.status === 'ok' : undefined
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')
  const commit = version.data?.commitHash && version.data.commitHash !== 'unknown' ? version.data.commitHash.slice(0, 7) : null

  return (
    <nav
      aria-label="Main"
      className={cn('sticky top-0 flex h-dvh w-[224px] shrink-0 flex-col gap-7 border-r border-line px-3.5 py-6', className)}
    >
      <Link href={`/${lang}`} className="flex items-center gap-2 px-2.5 font-mono text-sm text-fg no-underline hover:no-underline">
        <span className="size-2 rounded-[2px] bg-fg" />
        sleepypod
      </Link>
      <div className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((n) => {
          const on = n.id === active
          return (
            <Link
              key={n.id}
              href={`/${lang}${n.href === '/' ? '' : n.href}`}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-ctl px-2.5 py-[9px] text-sm no-underline transition-colors hover:no-underline',
                on ? 'bg-active text-fg' : 'text-fg-2 hover:bg-active',
              )}
            >
              <n.icon size={16} />
              {n.label}
            </Link>
          )
        })}
      </div>
      <div className="mt-auto flex flex-col gap-3.5 px-2.5">
        <div className={cn('flex items-center justify-between text-[13px]', developer ? 'text-fg' : 'text-fg-2')}>
          Developer
          <Toggle on={developer} onChange={setDeveloper} label="Developer mode" />
        </div>
        <div className="flex flex-col gap-1 border-t border-line pt-3.5 font-mono text-xs text-fg-2">
          <div className="flex items-center gap-2 text-fg">
            <span className={cn('size-1.5 rounded-full', healthy === undefined ? 'bg-fg-3' : healthy ? 'bg-ok' : 'bg-warn')} />
            {podName}
            {healthy !== undefined && (
              <span className="text-fg-2">
                {'· '}
                {healthy ? 'healthy' : 'degraded'}
              </span>
            )}
          </div>
          <div className="truncate whitespace-nowrap">
            {[host, commit].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
    </nav>
  )
}
