import { Suspense } from 'react'
import { AutopilotConsole } from '@/src/components/Autopilot/AutopilotConsole'

export default function AutopilotPage() {
  return (
    <Suspense>
      <AutopilotConsole />
    </Suspense>
  )
}
