import { Suspense } from 'react'
import { SleepSections } from '@/src/components/Sleep/SleepSections'

export default function SleepPage() {
  return (
    <Suspense>
      <SleepSections />
    </Suspense>
  )
}
