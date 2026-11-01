// One local calendar day of activity.
export type DayUsage = {
  // Input, output and cache tokens together.
  tokens: number
  // Model replies plus the person's own prompts.
  messages: number
  // Messages per local hour of the day ("0" to "23").
  hours: Record<string, number>
  // Tokens per model id.
  models: Record<string, number>
  // Ids of the sessions active that day.
  sessions: string[]
}

export type UsageSummary = {
  // Local dates (YYYY-MM-DD) with any activity.
  days: Record<string, DayUsage>
  updatedAt: number
}

export type UsageRange = 'all' | '30d' | '7d'

export type ScanStatus = {
  isScanning: boolean
  // Files read in the scan now running, of how many changed.
  done: number
  total: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      summary: Shaped<UsageSummary | null>
      status: ScanStatus
      range: UsageRange
    }
  }
}
