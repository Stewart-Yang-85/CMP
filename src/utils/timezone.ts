export type CronValidator = (expression: string) => boolean

export function resolveSystemTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof tz !== 'string') return null
  const value = tz.trim()
  return value ? value : null
}

export function ensureValidCronExpression(expression: unknown, label: string, validate: CronValidator) {
  const value = String(expression ?? '').trim()
  if (!value || !validate(value)) {
    const name = label ? `${label}` : 'cron expression'
    throw new Error(`Invalid ${name}: ${value || '(empty)'}`)
  }
  return value
}
