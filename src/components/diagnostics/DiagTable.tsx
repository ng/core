'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DiagColumn<T> {
  /** Stable key, also used as the sort identity. */
  key: string
  header: string
  render: (row: T) => ReactNode
  /** Provide to make the column sortable; returns the comparable value. */
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right'
}

/**
 * Dense sortable table on the design tokens (hairline rows, mono label
 * header). Click a sortable header to sort; click again to flip direction.
 * Scrolls horizontally inside its card on narrow screens.
 */
export function DiagTable<T>({
  columns,
  rows,
  getRowKey,
  empty = 'No data',
}: {
  columns: Array<DiagColumn<T>>
  rows: T[]
  getRowKey: (row: T, index: number) => string
  empty?: string
}) {
  const [sort, setSort] = useState<{ key: string, dir: 'asc' | 'desc' } | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find(c => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    return [...rows].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort, columns])

  const toggle = (key: string) =>
    setSort(prev => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  if (rows.length === 0) {
    return <p className="py-2 text-[13px] text-fg-3">{empty}</p>
  }

  return (
    <div className="-mx-[18px] overflow-x-auto px-[18px]">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {columns.map(c => (
              <th key={c.key} className={cn('sp-label whitespace-nowrap py-2 pr-4 font-normal last:pr-0', c.align === 'right' && 'text-right')}>
                {c.sortValue
                  ? (
                      <button
                        type="button"
                        onClick={() => toggle(c.key)}
                        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 uppercase text-inherit hover:text-fg"
                      >
                        {c.header}
                        {sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                      </button>
                    )
                  : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={getRowKey(row, i)} className="border-b border-line last:border-0 hover:bg-active">
              {columns.map(c => (
                <td key={c.key} className={cn('whitespace-nowrap py-2 pr-4 align-top last:pr-0', c.align === 'right' && 'text-right font-mono')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
