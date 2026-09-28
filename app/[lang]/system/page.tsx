import { Suspense } from 'react'
import { SystemScreen } from '@/src/components/System/SystemScreen'

export default function SystemPage() {
  return (
    <Suspense>
      <SystemScreen />
    </Suspense>
  )
}
