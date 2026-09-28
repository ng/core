'use client'

import { usePrefs } from '@/src/providers/PrefsProvider'
import { DataPipeline } from './DataPipeline'
import { StreamsCard } from './StreamsCard'
import { EventTimeline } from './EventTimeline'
import { RawFrameDrawer } from './RawFrameDrawer'

/** System → Pipeline tab (developer mode): DAG, stream rates, 60s event timeline. */
export function PipelineTab() {
  const { developer } = usePrefs()
  return (
    <div className="flex flex-col gap-3.5">
      <DataPipeline action={developer ? <RawFrameDrawer /> : undefined} />
      <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <StreamsCard />
        <EventTimeline />
      </div>
    </div>
  )
}
