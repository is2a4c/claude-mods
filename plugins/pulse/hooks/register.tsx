import type { EngineInterface, Register } from 'claude-code'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_KEY = 'pulse.deepseek-balance'
const BALANCE_TTL_MS = 60 * 1000
const BALANCE_RETRY_MS = 60 * 1000
const TICK_MS = 5000

type Balance = { cny: number; fetchedAt: number }

let balance: Balance | undefined
let sessionSpent = 0
let balanceBaseline = false
let forceBalance = false
let balanceAttemptedAt = 0

function readBalance(stored: unknown): Balance | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined
  const cny = (stored as { cny?: unknown }).cny
  const fetchedAt = (stored as { fetchedAt?: unknown }).fetchedAt
  if (typeof cny !== 'number' || !Number.isFinite(cny)) return undefined
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined
  return { cny, fetchedAt }
}

async function loadStoredBalance($: EngineInterface): Promise<Balance | undefined> {
  try {
    const stored = readBalance(await $.store.get(BALANCE_KEY))
    if (!stored) return undefined
    const now = await $.clock.now()
    return now - stored.fetchedAt < 10 * 60 * 1000 ? stored : undefined
  } catch {
    return undefined
  }
}

function parseBalance(text: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const infos = (parsed as { balance_infos?: unknown }).balance_infos
  if (!Array.isArray(infos)) return undefined
  for (const info of infos) {
    if (typeof info !== 'object' || info === null) continue
    if ((info as { currency?: unknown }).currency !== 'CNY') continue
    const total = Number((info as { total_balance?: unknown }).total_balance)
    if (Number.isFinite(total)) return total
  }
  return undefined
}

async function fetchBalance($: EngineInterface, key: string): Promise<Balance | undefined> {
  try {
    const response = await Promise.race([
      $.http
        .fetch(BALANCE_URL, { headers: { Authorization: `Bearer ${key}` } })
        .catch(() => undefined),
      $.clock.sleep(5000).then(() => undefined),
    ])
    if (!response?.ok) return undefined
    const cny = parseBalance(response.text)
    if (cny === undefined) return undefined
    const fetched = { cny, fetchedAt: await $.clock.now() }
    await $.store.set(BALANCE_KEY, fetched)
    return fetched
  } catch {
    return undefined
  }
}

async function refreshBalance($: EngineInterface, key: string | undefined): Promise<void> {
  if (!key) return
  const now = await $.clock.now()
  if (!forceBalance && balance && now - balance.fetchedAt < BALANCE_TTL_MS) return
  if (now - balanceAttemptedAt < BALANCE_RETRY_MS) return
  balanceAttemptedAt = now
  const fetched = await fetchBalance($, key)
  forceBalance = false
  if (!fetched) return
  if (balanceBaseline && balance && fetched.cny < balance.cny) {
    sessionSpent += balance.cny - fetched.cny
  }
  balance = fetched
  balanceBaseline = true
}

function yuan(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} ¥`
}

function formatLine(
  currentBalance: Balance | undefined,
  sessionCny: number | undefined,
): string | undefined {
  const parts: string[] = []
  if (currentBalance) parts.push(`баланс ${yuan(currentBalance.cny)}`)
  if (sessionCny !== undefined) parts.push(`сессия ${yuan(sessionCny)}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

async function tick($: EngineInterface): Promise<void> {
  try {
    $.ui.status(formatLine(balance, balance ? sessionSpent : undefined))
  } catch {}
}

export const register: Register = (on, options) => {
  const stored = options.deepseek_api_key
  const apiKey = typeof stored === 'string' && stored.trim() ? stored.trim() : undefined

  on('session.start', async ($, e, next) => {
    sessionSpent = 0
    balanceBaseline = false
    forceBalance = true
    balanceAttemptedAt = 0
    balance = apiKey ? await loadStoredBalance($) : undefined
    await tick($)
    void refreshBalance($, apiKey).then(() => tick($))
    $.clock.every(TICK_MS, async () => {
      await refreshBalance($, apiKey)
      await tick($)
    })
    return next(e)
  })

}
