import { describe, expect, it } from 'vitest'
import { chartCsv, chartFileName, chartRows, pickFilters, tipLabel, yearColors } from '../../src/renderer/lib/chartExport'
import { PALETTE } from '../../src/renderer/lib/graphElements'
import type { ChartData } from '../../src/shared/relations'

const bars: ChartData = {
  kind: 'bars',
  facet: 'task',
  bars: [
    { value: 'log_parsing', reviewed: 2, unreviewed: 1 },
    { value: 'a, "b"', reviewed: 0, unreviewed: 1 }
  ]
}
const bubbles: ChartData = { kind: 'bubbles', facet: 'task', facetY: 'llm_usage', xValues: ['a'], yValues: ['none'], cells: [{ x: 'a', y: 'none', reviewed: 1, unreviewed: 1 }] }
const years: ChartData = {
  kind: 'years',
  facet: 'task',
  years: [
    { year: 2020, value: 'b', reviewed: 1, unreviewed: 0 },
    { year: 2021, value: 'a', reviewed: 1, unreviewed: 2 }
  ]
}

describe('chart data for export and plotting', () => {
  it('writes CSV with quoting', () => {
    expect(chartCsv(bars)).toBe('task,reviewed,unreviewed,total\nlog_parsing,2,1,3\n"a, ""b""",0,1,1\n')
    expect(chartCsv(bubbles)).toBe('task,llm_usage,reviewed,unreviewed,total\na,none,1,1,2\n')
    expect(chartCsv(years)).toBe('year,task,reviewed,unreviewed,total\n2020,b,1,0,1\n2021,a,1,2,3\n')
  })

  it('names exported files after the chart', () => {
    expect(chartFileName(bars, 'csv')).toBe('bars-task.csv')
    expect(chartFileName(bubbles, 'svg')).toBe('bubbles-task-llm_usage.svg')
  })

  it('splits counts into reviewed and unreviewed rows for plotting', () => {
    expect(chartRows(bars)).toEqual([
      { x: 'log_parsing', y: null, value: 'log_parsing', count: 2, reviewed: true },
      { x: 'log_parsing', y: null, value: 'log_parsing', count: 1, reviewed: false },
      { x: 'a, "b"', y: null, value: 'a, "b"', count: 1, reviewed: false }
    ])
    expect(chartRows(bubbles)).toEqual([{ x: 'a', y: 'none', value: null, count: 2, reviewed: false }])
    expect(chartRows(years)).toHaveLength(3)
  })

  it('turns a clicked mark into library filters and a tooltip label', () => {
    expect(pickFilters(bars, chartRows(bars)[0])).toEqual([{ facet: 'task', value: 'log_parsing' }])
    expect(pickFilters(bubbles, chartRows(bubbles)[0])).toEqual([
      { facet: 'task', value: 'a' },
      { facet: 'llm_usage', value: 'none' }
    ])
    expect(pickFilters(years, chartRows(years)[0])).toEqual([{ facet: 'task', value: 'b' }])
    expect(tipLabel(bubbles, chartRows(bubbles)[0])).toBe('a × none')
    expect(tipLabel(years, chartRows(years)[0])).toBe('2020 · b')
  })

  it('colors the values of the per-year chart by how often they appear', () => {
    expect(yearColors(years as Extract<ChartData, { kind: 'years' }>)).toEqual(
      new Map([
        ['a', PALETTE[0]],
        ['b', PALETTE[1]]
      ])
    )
  })
})
