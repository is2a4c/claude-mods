import type { Register } from 'claude-code'

// Государственные праздники КНР: DeepSeek считает их off-peak весь день.
// 2026: 国办发明电〔2025〕7号; 2027: 国办发明电〔2026〕10号.
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-02',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-23',
  '2026-04-06',
  '2026-05-01',
  '2026-05-04',
  '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2027-01-01',
  '2027-02-05',
  '2027-02-08',
  '2027-02-09',
  '2027-02-10',
  '2027-02-11',
  '2027-02-12',
  '2027-04-05',
  '2027-05-03',
  '2027-05-04',
  '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01',
  '2027-10-04',
  '2027-10-05',
  '2027-10-06',
  '2027-10-07',
])

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function peakEndMinute(now: number): number | undefined {
  const date = new Date(now)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return undefined
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  if (HOLIDAYS.has(day)) return undefined
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  if (minute >= 60 && minute < 240) return 240
  if (minute >= 360 && minute < 600) return 600
  return undefined
}

function peakMessage(now: number): string | undefined {
  const end = peakEndMinute(now)
  if (end === undefined) return undefined
  const date = new Date(now)
  const left = end - (date.getUTCHours() * 60 + date.getUTCMinutes())
  const hours = Math.floor(left / 60)
  const rest = left % 60
  let leftText = `${rest} мин`
  if (hours > 0) leftText = rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`
  const endMsk = end + 180
  return `Сейчас peak-часы DeepSeek: API ×2, ещё ${leftText} (до ${pad(Math.floor(endMsk / 60))}:${pad(endMsk % 60)} MSK). Off-peak — вне 04:00–07:00 и 09:00–13:00 MSK, а также выходные и государственные праздники КНР.`
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    const message = peakMessage(await $.clock.now())
    if (message) $.ui.log(message)
    return next(e)
  })
}
