import { RulePage } from '@/src/components/Autopilot/RulePage'

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RulePage id={id} />
}
