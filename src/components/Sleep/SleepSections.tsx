'use client'

import { useCallback } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { PageHeader, SegmentedControl, Skeleton } from '@/src/components/ds'
import { SleepScreen } from './SleepScreen'
import { resolveSleepSection, SLEEP_SECTIONS, type SleepSection } from './sleepViews'

const BiometricsPanel = dynamic(
  () => import('@/src/components/diagnostics/BiometricsPanel').then(m => m.BiometricsPanel),
  { loading: () => <Skeleton className="h-64" /> },
)

/**
 * Sleep: Nights (the Night | Week | Month screen) and Biometrics. The section
 * lives in `?view=`; desktop switches it from the sidebar, phones from a
 * segmented switch.
 */
export function SleepSections() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const section = resolveSleepSection(searchParams.get('view'))

  const select = useCallback((next: SleepSection) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'nights') params.delete('view')
    else params.set('view', next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const sectionSwitch = (
    <SegmentedControl
      full
      ariaLabel="Sleep section"
      className="min-[900px]:hidden"
      options={SLEEP_SECTIONS.map(s => ({ value: s.id, label: s.label }))}
      value={section}
      onChange={select}
    />
  )

  if (section === 'nights') return <SleepScreen sectionSwitch={sectionSwitch} />

  return (
    <>
      <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Sleep /</span>
      <PageHeader
        title={(
          <>
            <span className="min-[900px]:hidden">Sleep</span>
            <span className="hidden min-[900px]:inline">Biometrics</span>
          </>
        )}
      />
      {sectionSwitch}
      <BiometricsPanel />
    </>
  )
}
