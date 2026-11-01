import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayUsage, UsageRange, UsageSummary } from '../types'

const PANE = 'usage-stats'
const TITLE = 'Usage'
// The per-file totals kept across sessions; bump the key when their shape changes.
const CACHE_KEY = 'scan-v2'

const summary = atom({ plugin: 'usage-stats', key: 'summary' } as const, null, {
  shape: 'summary-2',
})
const status = atom({ plugin: 'usage-stats', key: 'status' } as const, {
  isScanning: false,
  done: 0,
  total: 0,
  error: null,
})
const range = atom({ plugin: 'usage-stats', key: 'range' } as const, 'all')

const RANGES: { id: UsageRange; label: string; days: number; words: string }[] = [
  { id: 'all', label: 'All', days: Infinity, words: 'all time' },
  { id: '30d', label: '30d', days: 30, words: '30 days' },
  { id: '7d', label: '7d', days: 7, words: '7 days' },
]

// [UTC hour "YYYY-MM-DDTHH", input, output, cacheWrite, cacheRead, replies, prompts]
type HourRow = [string, number, number, number, number, number, number]
// [UTC hour, model, tokens]
type ModelRow = [string, string, number]
type FileTotals = {
  mtimeMs: number
  size: number
  // The session the file belongs to; null for a subagent's transcript.
  session: string | null
  hours: HourRow[]
  models: ModelRow[]
}
type Cache = Record<string, FileTotals>
type Transcript = { path: string; mtimeMs: number; size: number; session: string | null }

// A scan already running is joined, never started twice.
let running: Promise<void> | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-stats',
      description: 'Show your Claude Code usage: active days, streaks, tokens',
    })
    // The inline terminal pane takes a third of the screen, so there it waits
    // for the command. The app docks it beside the chat, but attaches after
    // the session starts: the pane opens when it does.
    if (e.surface !== null && e.surface !== 'terminal') openPane($)
    void refresh($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface !== 'terminal') openPane($)

    return attached
  })

  on('command.run', { command: 'usage-stats' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)

    return { text: 'Usage stats pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, summary)
    const scan = await read($, status)
    const selected = await read($, range)

    if (!data) {
      const words = scan.error
        ? `Could not read your transcripts: ${scan.error}`
        : scan.isScanning
          ? `Reading transcripts${scan.total > 0 ? ` ${scan.done}/${scan.total}` : ''}…`
          : 'No usage yet.'
      return <Text dimColor>{words}</Text>
    }

    const today = new Date(await $.clock.now())
    const stats = rangeStats(data.days, selected, today)
    const funFact = bookComparison(stats.tokens, today)

    const isTerminal = e.surface === 'terminal'
    const tabs = (
      <Box flexDirection="row" justifyContent="flex-end" gap={1}>
        {RANGES.map(r => {
          const isSelected = r.id === selected
          const label = (
            <Text size="footnote" dimColor={!isSelected} weight={isSelected ? 'semibold' : 'regular'}>
              {r.label}
            </Text>
          )
          const onPress = () => void update($, range, () => r.id)
          // The terminal sets the selected range on a filled chip, lighting the
          // others on hover. A desktop draws its own rounded buttons, so there the
          // selected range is a native button and the others plain.
          if (!isTerminal) {
            return isSelected ? (
              <Button key={`range-${r.id}`} variant="secondary" onPress={onPress}>
                {label}
              </Button>
            ) : (
              <Button key={`range-${r.id}`} plain onPress={onPress}>
                {label}
              </Button>
            )
          }
          return (
            <Box
              key={`tab-${r.id}`}
              paddingX={1}
              backgroundColor={isSelected ? 'subtle' : undefined}
              hover={isSelected ? undefined : { backgroundColor: 'subtle' }}
            >
              <Button key={`range-${r.id}`} plain onPress={onPress}>
                {label}
              </Button>
            </Box>
          )
        })}
      </Box>
    )

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const weeks = Math.max(8, Math.min(WEEKS, Math.floor((e.props.bodyColumns + 1) / 2)))
      const [hero, unit] = heroParts(stats.tokens)
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="column">
            <Text dimColor>TOTAL TOKENS · {rangeWords(selected).toUpperCase()}</Text>
            <Text bold>
              {hero}
              {unit} <Text dimColor>{trendLine(stats, selected)}</Text>
            </Text>
            <Text dimColor>{volumeLine(stats)}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {metricsFor(stats).map(m => (
              <Box key={m.label} flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
                <Text dimColor>{m.label}</Text>
                <Text bold>
                  {m.value}
                  {m.unit ? ` ${m.unit}` : ''}
                </Text>
                <Text dimColor>{m.note}</Text>
              </Box>
            ))}
          </Box>
          <Raster key="grid" columns={weeks * 2 - 1} rows={7} cells={rasterCells(data.days, selected, today, weeks)} />
          {funFact && <Text dimColor>{funFact}</Text>}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Svg
          source={panelSvg(stats, data.days, selected, today, layoutFor(e.props.bodyColumns), funFact)}
          alt={`${compact(stats.tokens)} tokens, ${commas(stats.messages)} messages, ${stats.activeDays} active days, a ${stats.currentStreak}-day streak`}
        />
        {scan.error && <Text dimColor>Last scan failed: {scan.error}</Text>}
      </Box>
    )
  })
}

// Opens the pane unasked; one that cannot be placed yet is left for the person.
function openPane($: EngineInterface): void {
  $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

// --- Scanning ---------------------------------------------------------------

function refresh($: EngineInterface): Promise<void> {
  running ??= scan($).finally(() => {
    running = undefined
  })

  return running
}

async function scan($: EngineInterface): Promise<void> {
  await update($, status, () => ({ isScanning: true, done: 0, total: 0, error: null }))
  try {
    const home = await $.env.get('HOME')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const transcripts = await listTranscripts($, `${configDir}/projects`)
    const stored = await $.store.get(CACHE_KEY)
    const old: Cache = stored && typeof stored === 'object' ? (stored as Cache) : {}

    const cache: Cache = {}
    const stale: Transcript[] = []
    for (const t of transcripts) {
      const was = old[t.path]
      if (was && was.mtimeMs === t.mtimeMs && was.size === t.size) cache[t.path] = was
      else stale.push(t)
    }

    await update($, status, s => ({ ...s, total: stale.length }))
    const script = `${$.plugin.root}/scripts/scan.awk`
    let done = 0
    for (const batch of batches(stale)) {
      const totals = await runScanner($, script, batch)
      for (const t of batch) cache[t.path] = totals[t.path] ?? emptyTotals(t)
      done += batch.length
      await update($, status, s => ({ ...s, done }))
    }

    await $.store.set(CACHE_KEY, cache)
    const result = summarize(cache, await $.clock.now())
    await update($, summary, () => result)
    await update($, status, () => ({ isScanning: false, done, total: stale.length, error: null }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, status, s => ({ ...s, isScanning: false, error }))
  }
}

async function listTranscripts($: EngineInterface, root: string): Promise<Transcript[]> {
  const found: Transcript[] = []
  const projects = await $.fs.list(root).catch(() => [])
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const dir = `${root}/${project.name}`
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        const session = entry.name.slice(0, -'.jsonl'.length)
        found.push({ path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs, size: entry.size, session })
      } else if (entry.kind === 'dir') {
        // A session's subagents keep their own transcripts beside it.
        const sub = `${dir}/${entry.name}/subagents`
        for (const agent of await $.fs.list(sub).catch(() => [])) {
          if (agent.kind !== 'file' || !agent.name.endsWith('.jsonl')) continue
          found.push({ path: `${sub}/${agent.name}`, mtimeMs: agent.mtimeMs, size: agent.size, session: null })
        }
      }
    }
  }

  return found
}

// Groups files so one awk run reads at most ~200 MB or 40 files.
function* batches(files: Transcript[]): Generator<Transcript[]> {
  let batch: Transcript[] = []
  let bytes = 0
  for (const f of files) {
    if (batch.length > 0 && (batch.length >= 40 || bytes + f.size > 200_000_000)) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(f)
    bytes += f.size
  }
  if (batch.length > 0) yield batch
}

async function runScanner(
  $: EngineInterface,
  script: string,
  batch: Transcript[],
): Promise<Record<string, FileTotals>> {
  const argv = ['/usr/bin/awk', '-f', script, '--', ...batch.map(t => t.path)]
  const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(argv, {
    timeoutMs: 300_000,
  })
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `awk exited ${exitCode}`)
  if (isStdoutTruncated) throw new Error('scanner output was cut short')

  const byPath = new Map(batch.map(t => [t.path, t]))
  const totals: Record<string, FileTotals> = {}
  let current: FileTotals | undefined
  for (const line of stdout.split('\n')) {
    const [kind, name = '', ...rest] = line.split('\t')
    if (kind === 'F') {
      const t = byPath.get(name)
      current = t ? (totals[t.path] = emptyTotals(t)) : undefined
    } else if (kind === 'H' && current) {
      const n = rest.map(Number)
      current.hours.push([name, n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0])
    } else if (kind === 'M' && current) {
      current.models.push([name, rest[0] ?? '', Number(rest[1] ?? 0)])
    }
  }

  return totals
}

function emptyTotals(t: Transcript): FileTotals {
  return { mtimeMs: t.mtimeMs, size: t.size, session: t.session, hours: [], models: [] }
}

// --- Summary ----------------------------------------------------------------

function summarize(cache: Cache, now: number): UsageSummary {
  const days: Record<string, DayUsage> = {}
  const dayOf = (hour: string) => {
    const date = new Date(`${hour}:00:00Z`)
    const usage = (days[localDay(date)] ??= { tokens: 0, messages: 0, hours: {}, models: {}, sessions: [] })
    return { usage, hour: String(date.getHours()) }
  }

  for (const file of Object.values(cache)) {
    for (const [utcHour, input, output, cw, cr, replies, prompts] of file.hours) {
      const { usage, hour } = dayOf(utcHour)
      usage.tokens += input + output + cw + cr
      usage.messages += replies + prompts
      usage.hours[hour] = (usage.hours[hour] ?? 0) + replies + prompts
      if (file.session && !usage.sessions.includes(file.session)) usage.sessions.push(file.session)
    }
    for (const [utcHour, model, tokens] of file.models) {
      const { usage } = dayOf(utcHour)
      usage.models[model] = (usage.models[model] ?? 0) + tokens
    }
  }

  return { days, updatedAt: now }
}

type RangeStats = {
  sessions: number
  messages: number
  tokens: number
  activeDays: number
  // Calendar days the range spans: 7, 30, or since the first active day.
  spanDays: number
  currentStreak: number
  // The longest run of active days, ever.
  bestStreak: number
  peakHour: number | null
  // The peak hour's share of the range's messages, 0 to 1.
  peakShare: number
  favoriteModel: string | null
  // The favorite model's share of the range's tokens, 0 to 1.
  modelShare: number
  firstDay: string | null
  // Tokens in the window of the same length just before; null for all time.
  previousTokens: number | null
  // Tokens per day, oldest first, ending today.
  series: number[]
}

function firstDayOf(selected: UsageRange, today: Date): string {
  const days = RANGES.find(r => r.id === selected)?.days ?? Infinity
  return Number.isFinite(days) ? localDay(addDays(today, 1 - days)) : ''
}

function rangeWords(selected: UsageRange): string {
  return RANGES.find(r => r.id === selected)?.words ?? ''
}

function isActiveDay(usage: DayUsage | undefined): usage is DayUsage {
  return (usage?.messages ?? 0) > 0
}

function rangeStats(days: Record<string, DayUsage>, selected: UsageRange, today: Date): RangeStats {
  const todayKey = localDay(today)
  const allActive = Object.keys(days)
    .filter(day => isActiveDay(days[day]) && day <= todayKey)
    .sort()
  const firstDay = allActive[0] ?? null
  const from = firstDayOf(selected, today) || firstDay || todayKey
  const spanDays = daysBetween(from, todayKey) + 1

  const sessions = new Set<string>()
  const hours = new Array<number>(24).fill(0)
  const models: Record<string, number> = {}
  let messages = 0
  let tokens = 0
  const active = allActive.filter(day => day >= from)
  for (const day of active) {
    const usage = days[day]
    if (!usage) continue
    usage.sessions.forEach(s => sessions.add(s))
    messages += usage.messages
    tokens += usage.tokens
    for (const [hour, n] of Object.entries(usage.hours)) hours[Number(hour)] = (hours[Number(hour)] ?? 0) + n
    for (const [model, n] of Object.entries(usage.models)) models[model] = (models[model] ?? 0) + n
  }

  let previousTokens: number | null = null
  if (selected !== 'all') {
    const before = localDay(addDays(parseDay(from), -spanDays))
    previousTokens = allActive
      .filter(day => day >= before && day < from)
      .reduce((sum, day) => sum + (days[day]?.tokens ?? 0), 0)
  }

  // The current streak runs back from today, or from yesterday before today's first message.
  const isActive = (date: Date) => isActiveDay(days[localDay(date)])
  let cursor = isActive(today) ? today : addDays(today, -1)
  let currentStreak = 0
  while (isActive(cursor)) {
    currentStreak++
    cursor = addDays(cursor, -1)
  }

  let bestStreak = 0
  let run = 0
  let previous: string | undefined
  for (const day of allActive) {
    run = previous && localDay(addDays(parseDay(previous), 1)) === day ? run + 1 : 1
    bestStreak = Math.max(bestStreak, run)
    previous = day
  }

  // All time draws the last 90 days at most: a longer line is a blur.
  const seriesFrom = selected === 'all' ? maxDay(from, localDay(addDays(today, -89))) : from
  const series: number[] = []
  for (let d = parseDay(seriesFrom); localDay(d) <= todayKey; d = addDays(d, 1)) {
    series.push(days[localDay(d)]?.tokens ?? 0)
  }

  const peak = Math.max(...hours)
  const modelTotal = Object.values(models).reduce((a, b) => a + b, 0)
  const [favorite, favoriteTokens = 0] = Object.entries(models).sort((a, b) => b[1] - a[1])[0] ?? []

  return {
    sessions: sessions.size,
    messages,
    tokens,
    activeDays: active.length,
    spanDays,
    currentStreak,
    bestStreak,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    peakShare: messages > 0 ? peak / messages : 0,
    favoriteModel: favorite ? modelName(favorite) : null,
    modelShare: modelTotal > 0 ? favoriteTokens / modelTotal : 0,
    firstDay,
    previousTokens,
    series,
  }
}

// A figure, the unit set smaller beside it, and a line of context beneath.
type Metric = { label: string; value: string; unit?: string; note: string }

// The four figures under the headline, each with the context that makes it mean something.
function metricsFor(stats: RangeStats): Metric[] {
  const [hour, meridiem] = stats.peakHour === null ? ['—'] : hourName(stats.peakHour).split(' ')
  return [
    {
      label: 'Active days',
      value: commas(stats.activeDays),
      note: `of ${plural(stats.spanDays, 'day')}`,
    },
    {
      label: 'Streak',
      value: String(stats.currentStreak),
      unit: stats.currentStreak === 1 ? 'day' : 'days',
      note: stats.bestStreak > stats.currentStreak ? `best ${stats.bestStreak}` : 'personal best',
    },
    {
      label: 'Peak hour',
      value: hour ?? '—',
      unit: meridiem,
      note: stats.peakHour === null ? 'no messages' : `${percent(stats.peakShare)} of messages`,
    },
    {
      label: 'Favorite model',
      value: stats.favoriteModel ?? '—',
      note: stats.favoriteModel ? `${percent(stats.modelShare)} of tokens` : 'no replies',
    },
  ]
}

function volumeLine(stats: RangeStats): string {
  return `${commas(stats.messages)} ${stats.messages === 1 ? 'message' : 'messages'} · ${plural(stats.sessions, 'session')}`
}

// How the range compares with the one before it, or where all time starts.
function trendLine(stats: RangeStats, selected: UsageRange): string {
  if (stats.previousTokens === null) return stats.firstDay ? `Since ${longDate(stats.firstDay)}` : ''
  const window = `prior ${rangeWords(selected)}`
  if (stats.previousTokens === 0) return stats.tokens > 0 ? `New vs ${window}` : `Quiet, as the ${window}`
  const change = (stats.tokens - stats.previousTokens) / stats.previousTokens
  if (Math.abs(change) < 0.005) return `Level with the ${window}`
  return `${change > 0 ? '↑' : '↓'} ${commas(Math.abs(change) * 100)}% vs ${window}`
}

// --- Drawing (desktop) ------------------------------------------------------

// One framed instrument, laid out for the pane's own width in CSS pixels:
// headline and trend, the four figures, the activity grid, then a footnote.
// It is drawn as an image, which the app sizes by the markup and fits to the
// pane; a frame (`isInteractive`) falls back to a 150px-tall box instead.

// The app measures a pane in cells of its code font, about 7.2px each.
const PX_PER_CELL = 7.2
const WEEKS = 26
const CELL_GAP = 3
const DAY_LABELS_W = 24

type Layout = {
  width: number
  pad: number
  inner: number
  // Below 440px the trend drops under the headline and the figures go 2 × 2:
  // four across need ~100px each for a note like "31% of messages".
  isCompact: boolean
}

function layoutFor(bodyColumns: number): Layout {
  const width = Math.round(Math.min(560, Math.max(260, bodyColumns * PX_PER_CELL)))
  const pad = width < 360 ? 14 : 18
  return { width, pad, inner: width - 2 * pad, isCompact: width < 440 }
}

const FONT = `-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif`
const DISPLAY = `-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif`

// Dark first, as the app opens; light follows the system. Intensity rises in
// luminance on dark and in depth on light, so busy days read as busier on both.
const STYLE = [
  `svg{--panel:#252525;--edge:rgba(255,255,255,.075);--sheen:rgba(255,255,255,.06);--rule:rgba(255,255,255,.07);`,
  `--fg:#f4f4f4;--fg2:#bdbdbd;--muted:#8e8e8e;--faint:#6e6e6e;--accent:#5f9cff;`,
  `--l0:#323232;--l1:#24467f;--l2:#2c5fb8;--l3:#3f82f2;--l4:#8dbbff}`,
  `@media (prefers-color-scheme:light){svg{--panel:#f7f7f6;--edge:rgba(0,0,0,.085);--sheen:rgba(255,255,255,.9);--rule:rgba(0,0,0,.075);`,
  `--fg:#161616;--fg2:#444444;--muted:#6f6f6f;--faint:#9a9a9a;--accent:#2f6fe0;`,
  `--l0:#e8e8e6;--l1:#d0e0fb;--l2:#98bdf4;--l3:#4c87e6;--l4:#1c56c0}}`,
  `text{font-family:${FONT};fill:var(--fg)}`,
  `.eyebrow{font-size:9px;font-weight:600;letter-spacing:.09em;fill:var(--muted)}`,
  `.hero{font-family:${DISPLAY};font-size:34px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums}`,
  `.unit{font-size:20px;font-weight:500;letter-spacing:0;fill:var(--fg2)}`,
  `.sub{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}`,
  `.value{font-family:${DISPLAY};font-size:17px;font-weight:500;letter-spacing:-.01em;font-variant-numeric:tabular-nums}`,
  `.value-unit{font-family:${FONT};font-size:12px;font-weight:500;letter-spacing:0;fill:var(--fg2)}`,
  `.note{font-size:10px;fill:var(--faint);font-variant-numeric:tabular-nums}`,
  `.axis{font-size:9px;fill:var(--faint)}`,
  `.foot{font-size:10.5px;fill:var(--muted);font-style:italic}`,
  `.rule{stroke:var(--rule);stroke-width:1}`,
  `.l0{fill:var(--l0)}.l1{fill:var(--l1)}.l2{fill:var(--l2)}.l3{fill:var(--l3)}.l4{fill:var(--l4)}`,
].join('')

function panelSvg(
  stats: RangeStats,
  days: Record<string, DayUsage>,
  selected: UsageRange,
  today: Date,
  layout: Layout,
  footnote: string | null,
): string {
  const { width, pad, inner, isCompact } = layout
  const right = width - pad
  const parts: string[] = []
  const text = (cls: string, x: number, y: number, body: string, anchor?: 'end') =>
    `<text class="${cls}" x="${r2(x)}" y="${r2(y)}"${anchor ? ` text-anchor="${anchor}"` : ''}>${body}</text>`
  const rule = (y: number) => parts.push(`<line class="rule" x1="${pad}" y1="${y}" x2="${right}" y2="${y}"/>`)

  // Headline: total tokens, then what produced them.
  let y = pad + 2
  const [hero, unit] = heroParts(stats.tokens)
  parts.push(
    text('eyebrow', pad, y + 8, `TOTAL TOKENS · ${esc(rangeWords(selected).toUpperCase())}`),
    `<text class="hero" x="${pad - 1.5}" y="${y + 46}">${esc(hero)}<tspan class="unit" dx="2">${esc(unit)}</tspan></text>`,
    text('sub', pad, y + 66, esc(volumeLine(stats))),
  )

  // Trend: beside the headline when there is room, else under it.
  if (isCompact) {
    y += 90
    parts.push(
      text('eyebrow', pad, y + 8, 'DAILY TOKENS'),
      text('sub', right, y + 8, esc(trendLine(stats, selected)), 'end'),
      sparkline(stats.series, pad, y + 16, inner, 30),
    )
    y += 64
  } else {
    const sparkW = Math.min(190, inner * 0.42)
    parts.push(
      text('eyebrow', right, y + 8, 'DAILY TOKENS', 'end'),
      sparkline(stats.series, right - sparkW, y + 18, sparkW, 34),
      text('sub', right, y + 66, esc(trendLine(stats, selected)), 'end'),
    )
    y += 80
  }
  rule(y)

  // The figures: a strip of four between hairlines, or two by two.
  const perRow = isCompact ? 2 : 4
  const columnW = inner / perRow
  metricsFor(stats).forEach((m, i) => {
    const column = i % perRow
    const top = y + 14 + Math.floor(i / perRow) * 62
    const x = pad + column * columnW + (column === 0 ? 0 : 12)
    if (column > 0) {
      const lx = pad + column * columnW
      parts.push(`<line class="rule" x1="${r2(lx)}" y1="${top}" x2="${r2(lx)}" y2="${top + 48}"/>`)
    }
    const unitSpan = m.unit ? `<tspan class="value-unit" dx="3">${esc(m.unit)}</tspan>` : ''
    parts.push(
      text('eyebrow', x, top + 9, esc(m.label.toUpperCase())),
      text('value', x, top + 31, esc(m.value) + unitSpan),
      text('note', x, top + 46, esc(m.note)),
    )
  })
  y += 14 + Math.ceil(4 / perRow) * 62
  rule(y)

  // The grid: as many whole weeks as fit at a comfortable cell, 26 at most.
  const gridW = inner - DAY_LABELS_W
  const weeks = Math.max(8, Math.min(WEEKS, Math.floor((gridW + CELL_GAP) / (11 + CELL_GAP))))
  const cell = (gridW - (weeks - 1) * CELL_GAP) / weeks
  const step = cell + CELL_GAP
  const gridX = pad + DAY_LABELS_W

  const head = y + 24
  parts.push(text('eyebrow', pad, head + 4, `ACTIVITY · ${weeks} WEEKS`))
  const swatch = 9
  const swatchesX = right - 24 - 5 * (swatch + 2.5)
  parts.push(text('axis', swatchesX - 5, head + 4, 'Less', 'end'))
  for (let level = 0; level < 5; level++) {
    parts.push(
      `<rect class="l${level}" x="${r2(swatchesX + level * (swatch + 2.5))}" y="${head - 4.5}" width="${swatch}" height="${swatch}" rx="2"/>`,
    )
  }
  parts.push(text('axis', right, head + 4, 'More', 'end'))

  const gridTop = head + 24
  const columns = gridDays(days, selected, today, weeks)

  // Months over the week their first day falls in, never crowding each other.
  let lastLabel = -4
  columns.forEach((column, w) => {
    const first = column.find(d => d.day.endsWith('-01'))
    const opening = w === 0 && !columns.slice(1, 4).some(c => c.some(d => d.day.endsWith('-01')))
    const labelled = first ?? (opening ? column[0] : undefined)
    if (labelled && w - lastLabel >= 4) {
      parts.push(text('axis', gridX + w * step, gridTop - 7, MONTHS[parseDay(labelled.day).getMonth()] ?? ''))
      lastLabel = w
    }
  })
  ;[
    [1, 'Mon'],
    [3, 'Wed'],
    [5, 'Fri'],
  ].forEach(([row, label]) => {
    parts.push(text('axis', pad, gridTop + Number(row) * step + cell / 2 + 3, String(label)))
  })

  const todayKey = localDay(today)
  columns.forEach((column, w) => {
    column.forEach((d, row) => {
      if (d.isFuture) return
      const x = gridX + w * step
      const top = gridTop + row * step
      parts.push(
        `<rect class="l${d.level}" x="${r2(x)}" y="${r2(top)}" width="${r2(cell)}" height="${r2(cell)}" rx="2.5"/>`,
      )
      // Today wears a ring, so the grid always says where "now" is.
      if (d.day === todayKey) {
        parts.push(
          `<rect x="${r2(x - 2)}" y="${r2(top - 2)}" width="${r2(cell + 4)}" height="${r2(cell + 4)}" rx="4" fill="none" stroke="var(--accent)" stroke-width="1.25"/>`,
        )
      }
    })
  })
  y = gridTop + 6 * step + cell

  // The footnote closes the plate, set in its measure like everything above.
  if (footnote) {
    y += 18
    rule(y)
    y += 6
    for (const line of wrap(footnote, Math.floor(inner / 5.4))) {
      y += 15
      parts.push(text('foot', pad, y, esc(line)))
    }
  }
  const height = y + pad

  // The frame: a hairline edge and a faint top sheen, like a machined plate.
  const frame =
    `<rect x=".5" y=".5" width="${width - 1}" height="${r2(height - 1)}" rx="12" fill="var(--panel)" stroke="var(--edge)"/>` +
    `<line x1="12" y1="1.5" x2="${width - 12}" y2="1.5" stroke="var(--sheen)"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${r2(height)}" width="${width}" height="${r2(height)}">` +
    `<style>${STYLE}</style>` +
    `<defs><linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="var(--accent)" stop-opacity=".30"/>` +
    `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>` +
    frame +
    parts.join('') +
    `</svg>`
  )
}

// A line with a soft fill beneath, scaled to the busiest day, ending in a dot.
function sparkline(series: number[], x0: number, top: number, w: number, h: number): string {
  const bottom = top + h
  const baseline = `<line class="rule" x1="${r2(x0)}" y1="${bottom + 0.5}" x2="${r2(x0 + w)}" y2="${bottom + 0.5}"/>`
  const max = Math.max(...series, 0)
  if (series.length === 0 || max === 0) return baseline

  const dx = series.length > 1 ? w / (series.length - 1) : 0
  const points = series.map((v, i): [number, number] => [
    x0 + (series.length > 1 ? i * dx : w),
    bottom - (v / max) * (h - 3),
  ])
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r2(x)} ${r2(y)}`).join('')
  const [lastX, lastY] = points[points.length - 1] ?? [x0 + w, bottom]
  const [firstX] = points[0] ?? [x0, bottom]

  return (
    baseline +
    `<path d="${line}L${r2(lastX)} ${bottom}L${r2(firstX)} ${bottom}Z" fill="url(#spark)"/>` +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${r2(lastX)}" cy="${r2(lastY)}" r="3.5" fill="var(--panel)"/>` +
    `<circle cx="${r2(lastX)}" cy="${r2(lastY)}" r="2.25" fill="var(--accent)"/>`
  )
}

// Breaks text into lines of at most `measure` characters, at spaces, then
// evens them out so the last line is never a lone word.
function wrap(words: string, measure: number): string[] {
  const greedy = breakAt(words, measure)
  if (greedy.length < 2) return greedy
  const even = breakAt(words, Math.ceil(words.length / greedy.length) + 4)
  return even.length === greedy.length ? even : greedy
}

function breakAt(words: string, measure: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of words.split(' ')) {
    if (line && line.length + 1 + word.length > measure) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

// --- Contribution grid ------------------------------------------------------

type GridDay = { day: string; level: number; usage?: DayUsage; isFuture: boolean }

// Columns of weeks, Sunday first, the last column holding today. Days outside
// the selected range are drawn empty.
function gridDays(days: Record<string, DayUsage>, selected: UsageRange, today: Date, weeks: number): GridDay[][] {
  const from = firstDayOf(selected, today)
  const todayKey = localDay(today)
  const start = addDays(today, -today.getDay() - (weeks - 1) * 7)
  const values = Object.entries(days)
    .filter(([day, d]) => day >= from && d.messages > 0)
    .map(([, d]) => d.tokens)
    .sort((a, b) => a - b)
  const quartile = (q: number) => values[Math.floor((values.length - 1) * q)] ?? 0
  const cuts = [quartile(0.25), quartile(0.5), quartile(0.75)]

  const columns: GridDay[][] = []
  for (let w = 0; w < weeks; w++) {
    const column: GridDay[] = []
    for (let d = 0; d < 7; d++) {
      const day = localDay(addDays(start, w * 7 + d))
      const usage = days[day]
      const isCounted = usage !== undefined && usage.messages > 0 && day >= from
      const level = isCounted ? 1 + cuts.filter(c => usage.tokens > c).length : 0
      column.push({ day, level, usage, isFuture: day > todayKey })
    }
    columns.push(column)
  }

  return columns
}

// The terminal draws the grid as a Raster: one block per day, a space between weeks.
const LEVEL_RGB = [0, 0x24467f, 0x2c5fb8, 0x3f82f2, 0x8dbbff]
const DEFAULT_COLOR = 0x01000000

function rasterCells(days: Record<string, DayUsage>, selected: UsageRange, today: Date, weeks: number): string {
  const columns = gridDays(days, selected, today, weeks)
  const width = weeks * 2 - 1
  const words = new Uint32Array(width * 7 * 3)
  for (let row = 0; row < 7; row++) {
    for (let x = 0; x < width; x++) {
      const at = (row * width + x) * 3
      const d = x % 2 === 0 ? columns[x / 2]?.[row] : undefined
      if (!d || d.isFuture) words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], at)
      else if (d.level === 0) words.set([0x2591, DEFAULT_COLOR, DEFAULT_COLOR], at)
      else words.set([0x2588, LEVEL_RGB[d.level] ?? DEFAULT_COLOR, DEFAULT_COLOR], at)
    }
  }

  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

// --- The line under the grid ------------------------------------------------

// Word counts; a word is about 4/3 of a token.
const BOOKS: [string, number][] = [
  ['The Little Prince', 17_000],
  ['Animal Farm', 30_000],
  ['The Great Gatsby', 47_000],
  ["Harry Potter and the Philosopher's Stone", 77_000],
  ['The Hobbit', 95_000],
  ['Pride and Prejudice', 122_000],
  ['Moby-Dick', 206_000],
  ['The Lord of the Rings', 480_000],
  ['War and Peace', 587_000],
]

// One book per day, among those the tokens outnumber.
function bookComparison(tokens: number, today: Date): string | null {
  const fits = BOOKS.filter(([, words]) => tokens >= (words * 4) / 3)
  if (fits.length === 0) return null
  const seed = localDay(today)
    .split('')
    .reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7)
  const [title, words] = fits[seed % fits.length] ?? fits[0]!
  const ratio = tokens / ((words * 4) / 3)
  const times = ratio < 10 ? ratio.toFixed(1).replace(/\.0$/, '') : commas(Math.round(ratio))

  return `You've used ~${times}× more tokens than ${title}`
}

// --- Formatting -------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDay(day: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

// Calendar arithmetic at local noon, so a DST change never skips a day.
function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 12)
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000)
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b
}

function longDate(day: string): string {
  const date = parseDay(day)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

function hourName(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`
}

// "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5".
function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  const family = parts.find(p => /^[a-z]+$/i.test(p))
  if (!family) return id
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`
}

function commas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function compact(n: number): string {
  const one = (v: number) => v.toFixed(1).replace(/\.0$/, '')
  if (n >= 1e9) return `${one(n / 1e9)}B`
  if (n >= 1e6) return `${one(n / 1e6)}M`
  if (n >= 1e3) return `${one(n / 1e3)}K`
  return String(n)
}

// The headline figure to three significant digits, its unit apart: ["1.28", "B"].
function heroParts(n: number): [string, string] {
  const scale: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, unit] of scale) {
    if (n >= size) {
      const v = n / size
      return [v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit]
    }
  }
  return [String(n), '']
}

function percent(share: number): string {
  return share >= 0.995 ? '100%' : share < 0.01 && share > 0 ? '<1%' : `${Math.round(share * 100)}%`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
