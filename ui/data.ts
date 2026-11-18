import { useCallback, useEffect, useState } from 'react'
import type { monitorMetrics, seriesFor } from '../server/analytics'
import type { presentMonitor } from '../server/model'

type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: object; headers?: HeadersInit }
type Result<T> = { data: T | undefined; error: string | null; nextOffset: number | null }

export type User = { name: string; email: string }
export type Session = { user: User } | null
export type Point = Awaited<ReturnType<typeof seriesFor>>[number]
export type Monitor = ReturnType<typeof presentMonitor> & { uptime: number | null; avgLatency: number | null }
export type IncidentSummary = { id: string; monitorName: string; title: string; openedAt: number; resolvedAt: number | null }
export type Incident = IncidentSummary & {
  monitorId: string; acknowledgedAt: number | null;
  events: { kind: string; message: string | null; createdAt: number }[];
}
export type OverviewData = {
  total: number; operational: number; degraded: number; down: number; uptime: number | null;
  avgLatency: number | null; activeIncidents: number; series: Point[];
}
export type DetailData = {
  monitor: Monitor; metrics: Awaited<ReturnType<typeof monitorMetrics>>; series: Point[];
  checks: { scheduledAt: number; checkedAt: number | null; ok: boolean | null; latencyMs: number | null; httpStatus: number | null; error: string | null }[];
  incidents: Incident[]; lastSuccess: number | null; lastFailure: number | null;
}
export type ChannelKind = 'email' | 'discord' | 'webhook'
export type Channel = { id: string; name: string; kind: ChannelKind; events: string[]; cooldownSeconds: number }
export type Delivery = { id: string; channelName: string; monitorName: string; eventKind: string; status: string; attempts: number; error: string | null; createdAt: number; sentAt: number | null; nextAt: number | null }
export type StatusPage = { id: string; title: string; slug: string; description: string; monitorIds: string[] }
export type PublicPage = {
  title: string; description: string; state: Monitor['state'];
  monitors: (Pick<Monitor, 'id' | 'name' | 'state' | 'uptime'> & { series: Omit<Point, 'avgLatency'>[] })[];
  incidents: IncidentSummary[];
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : 'An unexpected error occurred.'
export const formText = (form: FormData, name: string) => String(form.get(name) ?? '')

async function call<T>(path: string, { method = 'GET', body, headers }: RequestOptions = {}) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = payload as { error?: { message?: string }; message?: string } | null
    throw new Error(error?.error?.message ?? error?.message ?? `Request failed (${response.status}).`)
  }
  const unwrapped = typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : payload
  const next = response.headers.get('X-Next-Offset')
  return { data: unwrapped as T, nextOffset: next === null ? null : Number(next) }
}

export async function request<T = unknown>(path: string, options?: RequestOptions) {
  return (await call<T>(path, options)).data
}

export function useData<T>(path: string, refresh = 0) {
  const [result, setResult] = useState<Result<T> & { path: string }>({ path, data: undefined, error: null, nextOffset: null })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => {
    let current = true
    call<T>(path).then(
      value => current && setResult({ path, ...value, error: null }),
      error => current && setResult({ path, data: undefined, error: errorText(error), nextOffset: null }),
    )
    return () => { current = false }
  }, [path, refresh, attempt])
  return result.path === path ? { ...result, retry } : { data: undefined, error: null, nextOffset: null, retry }
}

export const stateLabels: Record<string, string> = {
  operational: 'Operational',
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  paused: 'Paused',
  pending: 'Pending',
  unknown: 'Unknown',
}

const dateAndTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
})
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const dateWithYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
export const dateTime = (value: number | null | undefined) => value == null ? '—' : dateAndTime.format(value) + ' UTC'
export const calendarDate = (value: number) => dateOnly.format(value)
export const expiryDate = (value: number | null) => value == null ? '—' : dateWithYear.format(value)
export const clockTime = (value: number) => hourOnly.format(value)
export const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)}%`
export const latency = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value).toLocaleString()} ms`
export function duration(value: number | null | undefined) {
  if (value == null) return '—'
  const seconds = Math.round(value)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m` + (seconds % 60 ? ` ${seconds % 60}s` : '')
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`
}
