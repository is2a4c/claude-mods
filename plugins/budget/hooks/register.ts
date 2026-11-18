import type { EngineInterface, Register } from 'claude-code'

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'
const PULSE_RATE_KEY = 'pulse.usd-rub'
const RATE_KEY = 'budget.rate'
const LEDGER_KEY = 'budget.ledger'
const LAST_KEY = 'budget.last'
const BACKFILL_KEY = 'budget.backfill'
const LIMIT_KEY = 'budget.limitRub'
const LIMIT_WARN_KEY = 'budget.limitWarned'
const CTX_KEY = 'budget.ctxWarned'
const RATE_TTL_MS = 12 * 60 * 60 * 1000
const RETRY_MS = 30 * 60 * 1000
const TICK_MS = 30000
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

type Rate = { value: number; fetchedAt: number }
type Entry = { at: number; usd: number }
type Last = { startedAt: number; usd: number }
type CtxWarn = { startedAt: number; level: number }
type LimitWarn = { day: string; limit: number }

let rate: Rate | undefined
let attemptedAt = 0
let busy = false

function asRate(value: unknown): Rate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const amount = (value as { value?: unknown }).value
  const fetchedAt = (value as { fetchedAt?: unknown }).fetchedAt
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined
  return { value: amount, fetchedAt }
}

function asLast(value: unknown): Last | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const startedAt = (value as { startedAt?: unknown }).startedAt
  const usd = (value as { usd?: unknown }).usd
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return undefined
  return { startedAt, usd }
}

function asCtxWarn(value: unknown): CtxWarn | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const startedAt = (value as { startedAt?: unknown }).startedAt
  const level = (value as { level?: unknown }).level
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (typeof level !== 'number' || !Number.isFinite(level)) return undefined
  return { startedAt, level }
}

function asLimitWarn(value: unknown): LimitWarn | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const day = (value as { day?: unknown }).day
  const limit = (value as { limit?: unknown }).limit
  if (typeof day !== 'string') return undefined
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  return { day, limit }
}

function asLedger(value: unknown): Entry[] {
  if (!Array.isArray(value)) return []
  const entries: Entry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const at = (item as { at?: unknown }).at
    const usd = (item as { usd?: unknown }).usd
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) continue
    entries.push({ at, usd })
  }
  return entries
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

async function readKey($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function writeKey($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {}
}

async function fetchRate($: EngineInterface): Promise<Rate | undefined> {
  try {
    const response = await Promise.race([
      $.http.fetch(CBR_URL).catch(() => undefined),
      $.clock.sleep(5000).then(() => undefined),
    ])
    if (!response?.ok) return undefined
    const block = response.text
      .split('<Valute ')
      .find((chunk) => chunk.includes('<CharCode>USD</CharCode>'))
    if (!block) return undefined
    const raw = block.match(/<Value>([\d.,]+)<\/Value>/)?.[1]
    const nominal = Number(block.match(/<Nominal>([\d.,]+)<\/Nominal>/)?.[1]?.replace(',', '.') ?? '1')
    const value = raw
      ? Number(raw.replace(',', '.')) / (Number.isFinite(nominal) && nominal > 0 ? nominal : 1)
      : NaN
    if (!Number.isFinite(value) || value <= 0) return undefined
    return { value, fetchedAt: await $.clock.now() }
  } catch {
    return undefined
  }
}

async function ensureRate($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (rate && now - rate.fetchedAt < RATE_TTL_MS) return
  const pulse = asRate(await readKey($, PULSE_RATE_KEY))
  if (pulse && now - pulse.fetchedAt < RATE_TTL_MS) {
    rate = pulse
    return
  }
  if (now - attemptedAt < RETRY_MS) return
  attemptedAt = now
  const own = asRate(await readKey($, RATE_KEY))
  if (own && now - own.fetchedAt < RATE_TTL_MS) {
    rate = own
    return
  }
  const fetched = await fetchRate($)
  if (fetched) {
    rate = fetched
    await writeKey($, RATE_KEY, fetched)
    return
  }
  if (!rate) rate = own ?? pulse
}

function dayStart(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayKey(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

async function totals($: EngineInterface, now: number): Promise<{ today: number; week: number }> {
  const entries = asLedger(await readKey($, LEDGER_KEY))
  const start = dayStart(now)
  const weekStart = now - 7 * 24 * 60 * 60 * 1000
  let today = 0
  let week = 0
  for (const entry of entries) {
    if (entry.at >= start) today += entry.usd
    if (entry.at >= weekStart) week += entry.usd
  }
  return { today, week }
}

async function addUsd($: EngineInterface, now: number, usd: number): Promise<void> {
  if (usd <= 0.00005) return
  const entries = asLedger(await readKey($, LEDGER_KEY))
  entries.push({ at: now, usd })
  await writeKey(
    $,
    LEDGER_KEY,
    entries.filter((entry) => entry.at >= now - KEEP_MS),
  )
}

async function record($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const usd = usage.cost?.usd
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return
  const now = await $.clock.now()
  const last = asLast(await readKey($, LAST_KEY))
  const backfillRaw = await readKey($, BACKFILL_KEY)
  const backfilled = typeof backfillRaw === 'number' ? backfillRaw : 0

  if (!last || last.startedAt !== usage.startedAt) {
    if (usage.startedAt >= dayStart(now)) await addUsd($, now, usd)
    await writeKey($, LAST_KEY, { startedAt: usage.startedAt, usd })
    await writeKey($, BACKFILL_KEY, usage.startedAt)
    return
  }

  if (backfilled !== usage.startedAt) {
    if (usage.startedAt >= dayStart(now)) await addUsd($, now, last.usd)
    await writeKey($, BACKFILL_KEY, usage.startedAt)
  }

  const delta = usd - last.usd
  if (delta > 0.00005) {
    await addUsd($, now, delta)
    await writeKey($, LAST_KEY, { startedAt: usage.startedAt, usd })
  }
}

async function check($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const percent = usage.context.percent
  if (typeof percent === 'number' && percent >= 75) {
    const level = percent >= 90 ? 90 : 75
    const previous = asCtxWarn(await readKey($, CTX_KEY))
    if (!previous || previous.startedAt !== usage.startedAt || previous.level < level) {
      await writeKey($, CTX_KEY, { startedAt: usage.startedAt, level })
      $.ui.toast(
        level >= 90
          ? `Контекст ${percent}% — авто-компакт рядом`
          : `Контекст ${percent}% — готовься к компакту`,
      )
    }
  }

  const limit = asCount(await readKey($, LIMIT_KEY))
  if (limit <= 0) return
  const now = await $.clock.now()
  const sums = await totals($, now)
  const rub = rate ? sums.today * rate.value : 0
  if (rub <= limit) return
  const day = dayKey(now)
  const warned = asLimitWarn(await readKey($, LIMIT_WARN_KEY))
  if (warned && warned.day === day && warned.limit === Math.round(limit)) return
  await writeKey($, LIMIT_WARN_KEY, { day, limit: Math.round(limit) })
  $.ui.toast(`Дневной лимит ${Math.round(limit)} ₽ превышен: ${Math.round(rub)} ₽`)
}

function rubles(usd: number): string {
  if (!rate) return `${usd.toFixed(2)}$`
  const rub = usd * rate.value
  return `${rub < 100 ? rub.toFixed(1).replace('.', ',') : Math.round(rub)} ₽ (${usd.toFixed(2)}$)`
}

async function report($: EngineInterface): Promise<string> {
  await ensureRate($)
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const sums = await totals($, now)
  const lines: string[] = []
  lines.push(`Сегодня: ${rubles(sums.today)}`)
  lines.push(`7 дней: ${rubles(sums.week)}`)
  const sessionUsd = usage.cost?.usd
  const context =
    typeof usage.context.percent === 'number' ? ` · контекст ${usage.context.percent}%` : ''
  lines.push(`Сессия: ${typeof sessionUsd === 'number' ? rubles(sessionUsd) : '—'}${context}`)
  const limit = asCount(await readKey($, LIMIT_KEY))
  const course = rate ? `${rate.value.toFixed(4).replace('.', ',')} ₽` : 'нет'
  lines.push(`Курс: ${course}${limit > 0 ? ` · лимит ${Math.round(limit)} ₽/день` : ''}`)
  return lines.join('\n')
}

async function commandRun($: EngineInterface, args: string): Promise<string> {
  const match = args.trim().match(/^limit\s+(.+)$/i)
  const raw = match?.[1]?.trim().toLowerCase()
  if (raw === 'off' || raw === '0') {
    await writeKey($, LIMIT_KEY, 0)
    return 'Дневной лимит снят.'
  }
  if (raw !== undefined) {
    const value = Number(raw.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) {
      return 'Укажи сумму в рублях: /spend limit 500, или /spend limit off.'
    }
    await writeKey($, LIMIT_KEY, value)
    return `Дневной лимит: ${Math.round(value)} ₽.`
  }
  return report($)
}

async function tick($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    await ensureRate($)
    await record($)
    await check($)
  } catch {
  } finally {
    busy = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend',
      description: 'Расход в рублях: сегодня, 7 дней и в этой сессии',
      argumentHint: '[limit <₽>|off]',
    })
    void tick($)
    $.clock.every(TICK_MS, async () => {
      await tick($)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await tick($)
    return next(e)
  })

  on('command.run', { command: 'spend' }, async ($, e) => ({
    text: await commandRun($, e.args),
  }))
}
