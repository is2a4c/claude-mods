import type { EngineInterface, Register } from 'claude-code'

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'
const RATE_KEY = 'pulse.usd-rub'
const RATE_TTL_MS = 12 * 60 * 60 * 1000
const RETRY_MS = 30 * 60 * 1000
const TICK_MS = 5000

type Rate = { value: number; fetchedAt: number }

let rate: Rate | undefined
let attemptedAt = 0

function readRate(stored: unknown): Rate | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined
  const value = (stored as { value?: unknown }).value
  const fetchedAt = (stored as { fetchedAt?: unknown }).fetchedAt
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined
  return { value, fetchedAt }
}

async function loadStoredRate($: EngineInterface): Promise<Rate | undefined> {
  try {
    return readRate(await $.store.get(RATE_KEY))
  } catch {
    return undefined
  }
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
    const fetched = { value, fetchedAt: await $.clock.now() }
    await $.store.set(RATE_KEY, fetched)
    return fetched
  } catch {
    return undefined
  }
}

async function refreshRate($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (rate && now - rate.fetchedAt < RATE_TTL_MS) return
  if (now - attemptedAt < RETRY_MS) return
  attemptedAt = now
  const fetched = await fetchRate($)
  if (fetched) rate = fetched
}

type Spend = { today: number; week: number }

function dayStart(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

async function readSpend($: EngineInterface): Promise<Spend | undefined> {
  try {
    const raw = await $.store.get('budget.ledger')
    if (!Array.isArray(raw)) return undefined
    const now = await $.clock.now()
    const start = dayStart(now)
    const weekStart = now - 7 * 24 * 60 * 60 * 1000
    let today = 0
    let week = 0
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const at = (item as { at?: unknown }).at
      const usd = (item as { usd?: unknown }).usd
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      if (typeof usd !== 'number' || !Number.isFinite(usd)) continue
      if (at >= start) today += usd
      if (at >= weekStart) week += usd
    }
    return { today, week }
  } catch {
    return undefined
  }
}

function money(usd: number, current: Rate | undefined): string {
  if (!current) return `${usd.toFixed(2)}$`
  const rub = usd * current.value
  return `${rub < 100 ? rub.toFixed(1).replace('.', ',') : Math.round(rub)} ₽`
}

function formatLine(
  usage: Awaited<ReturnType<EngineInterface['session']['usage']>>,
  current: Rate | undefined,
  spend: Spend | undefined,
): string {
  const parts: string[] = []
  if (typeof usage.context.percent === 'number') parts.push(`контекст ${usage.context.percent}%`)
  if (spend) {
    parts.push(`день ${money(spend.today, current)}`)
    parts.push(`неделя ${money(spend.week, current)}`)
  } else if (usage.cost) {
    parts.push(money(usage.cost.usd, current))
  } else {
    parts.push('— ₽')
  }
  const five = usage.rateLimits.find((limit) => limit.kind === 'five_hour')
  const week = usage.rateLimits.find((limit) => limit.kind === 'seven_day')
  if (five) parts.push(`5ч ${Math.round(five.percentUsed)}%`)
  if (week) parts.push(`7д ${Math.round(week.percentUsed)}%`)
  return parts.join(' · ')
}

async function tick($: EngineInterface): Promise<void> {
  try {
    const spend = await readSpend($)
    $.ui.status(formatLine(await $.session.usage(), rate, spend))
  } catch {}
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    rate = await loadStoredRate($)
    await tick($)
    void refreshRate($).then(() => tick($))
    $.clock.every(TICK_MS, async () => {
      await refreshRate($)
      await tick($)
    })
    return next(e)
  })

}
