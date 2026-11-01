import type { FsEntry, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-stats',
  component: 'Pane',
  requestId: 'usage-stats',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ROOT = '/home/u/.claude/projects'
const FILE = `${ROOT}/-proj/a.jsonl`

// What scripts/scan.awk prints for one transcript: noon UTC on four days,
// three of them in a row ending today.
const SCANNED = [
  `F\t${FILE}`,
  'H\t2026-10-20T12\t10\t1000\t50\t5000\t4\t1',
  'H\t2026-10-30T12\t10\t2000\t50\t5000\t6\t2',
  'H\t2026-10-31T12\t10\t3000\t50\t5000\t8\t2',
  'H\t2026-11-01T12\t10\t4000\t50\t5000\t2\t1',
  'M\t2026-10-30T12\tclaude-opus-5-5\t7060',
  'M\t2026-10-31T12\tclaude-sonnet-4-5-20250929\t9000',
  '',
].join('\n')

function world(on: On) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 1, 15) })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  on('command.register', () => ({ value: { command: 'usage-stats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    const listing: Record<string, FsEntry[]> = {
      [ROOT]: [{ name: '-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
      [`${ROOT}/-proj`]: [{ name: 'a.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }],
    }
    const entries = listing[e.path]
    if (!entries) throw new Error('ENOENT')
    return { value: entries }
  })
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return {
      value: { exitCode: 0, stdout: SCANNED, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  return { clock, runs }
}

test('the pane shows the stats on every surface, and the range tabs narrow them', async ($, on) => {
  const { clock, runs } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(runs).toHaveLength(1)
  expect(runs[0]?.at(-1)).toBe(FILE)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
    if (surface === 'terminal') {
      const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
      // 4 × 10 + 10,000 + 4 × 50 + 4 × 5,000 tokens over 26 messages.
      expect(all).toContain('30.2K')
      expect(all).toContain('26 messages · 1 session')
      expect(all).toContain('Since Oct 20, 2026')
      expect(all).toContain('of 13 days')
      expect(all).toContain('3 days')
      expect(all).toContain('personal best')
      // Noon UTC, in whatever zone the test runs in.
      const noon = new Date(Date.UTC(2026, 10, 1, 12)).getHours()
      expect(all).toContain(`${noon % 12 === 0 ? 12 : noon % 12} ${noon < 12 ? 'AM' : 'PM'}`)
      expect(all).toContain('Sonnet 4.5')
    }
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = async () => JSON.stringify(await ui.find({ type: 'Svg' }))
  expect(await svg()).toContain('TOTAL TOKENS · ALL TIME')
  expect(await svg()).toContain('>30.2<tspan')
  expect(await svg()).toContain('26 messages · 1 session')
  await ui.press({ key: 'range-7d' })
  // Oct 20 falls in the week before: 24,180 tokens against its 6,060.
  expect(await svg()).toContain('TOTAL TOKENS · 7 DAYS')
  expect(await svg()).toContain('21 messages · 1 session')
  expect(await svg()).toContain('↑ 299% vs prior 7 days')
  expect(await svg()).toContain('of 7 days')
  // The book line closes the plate rather than trailing under it.
  expect(await svg()).toContain('more tokens than')
  expect(await svg()).toContain('ACTIVITY · 26 WEEKS')
  await ui.unmount()

  // A narrow pane gets fewer, still comfortable, weeks rather than a shrunken drawing.
  const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  const source = JSON.stringify(await narrow.find({ type: 'Svg' }))
  expect(source).toContain('ACTIVITY · 17 WEEKS')
  expect(source).toContain('viewBox=\\"0 0 288 ')
  expect(source).not.toContain('isInteractive')
  await narrow.unmount()

  // An unchanged transcript is read from the store, not scanned again.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(runs).toHaveLength(1)
})

test('before any scan the pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No usage yet.')
  await ui.unmount()
})
