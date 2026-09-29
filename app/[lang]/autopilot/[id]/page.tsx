import { RulePage } from '@/src/components/Autopilot/RulePage'

export default async function AutomationPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ template?: string | string[] }>
}) {
  const { id } = await params
  const { template } = await searchParams
  return <RulePage id={id} template={typeof template === 'string' ? template : undefined} />
}
