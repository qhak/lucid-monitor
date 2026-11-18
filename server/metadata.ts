import { parse } from 'tldts'
import { readBoundedText, safeFetch, validateTarget } from './probe'

const METADATA_TIMEOUT_MS = 5_000
const JSON_LIMIT = 256 * 1024
const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json'
const RFC3339_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

function expirationTime(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339_DATE.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function validateProviderUrl(input: string): URL {
  const parsed = new URL(input)
  const url = validateTarget(input, parsed.hostname)
  if (url.protocol !== 'https:') throw new Error('Metadata sources require HTTPS.')
  return url
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    return null
  }
  return JSON.parse(await readBoundedText(response, JSON_LIMIT, signal))
}

async function domainExpiration(hostname: string, signal: AbortSignal): Promise<number | null> {
  const { domain, isIcann, isPrivate } = parse(hostname, { allowPrivateDomains: true })
  if (!domain || !isIcann || isPrivate) return null
  const bootstrap = await readJson(await fetch(RDAP_BOOTSTRAP, { redirect: 'manual', signal }), signal) as {
    services?: [string[], string[]][]
  } | null
  if (!Array.isArray(bootstrap?.services)) return null
  const suffixes = domain.split('.')
  let baseUrl: string | undefined
  for (let first = 0; first < suffixes.length && !baseUrl; first++) {
    const suffix = suffixes.slice(first).join('.')
    const service = bootstrap.services.find(([labels]) => labels.includes(suffix))
    baseUrl = service?.[1].find((url) => url.startsWith('https:'))
  }
  if (!baseUrl) return null
  const endpoint = validateProviderUrl(baseUrl)
  if (endpoint.search) return null
  endpoint.pathname = `${endpoint.pathname.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`
  const response = await safeFetch(endpoint.href, endpoint.hostname, {
    signal,
    headers: { Accept: 'application/rdap+json' },
  })
  const record = await readJson(response, signal) as {
    objectClassName?: string
    ldhName?: string
    events?: { eventAction?: string; eventDate?: string }[]
  } | null
  if (record?.objectClassName !== 'domain' || record.ldhName?.toLowerCase() !== domain ||
    !Array.isArray(record.events)) return null
  const expirations = new Set(record.events
    .filter((event) => event?.eventAction === 'expiration')
    .map((event) => expirationTime(event.eventDate)))
  return expirations.size === 1 ? [...expirations][0] ?? null : null
}

async function certificateExpiration(
  hostname: string,
  providerUrl: string,
  token: string | undefined,
  signal: AbortSignal,
): Promise<number | null> {
  const provider = validateProviderUrl(providerUrl)
  provider.searchParams.set('hostname', hostname)
  const headers = new Headers({ Accept: 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await safeFetch(provider.href, provider.hostname, { signal, headers })
  const record = await readJson(response, signal) as { hostname?: string; certificateExpiresAt?: string } | null
  return record?.hostname?.toLowerCase() === hostname ? expirationTime(record.certificateExpiresAt) : null
}

export async function readExpiration(input: string, config: {
  TLS_METADATA_URL?: string
  TLS_METADATA_TOKEN?: string
}): Promise<{ certificateExpiresAt: number | null; domainExpiresAt: number | null }> {
  const url = new URL(input)
  const signal = AbortSignal.timeout(METADATA_TIMEOUT_MS)
  const [certificateExpiresAt, domainExpiresAt] = await Promise.all([
    url.protocol === 'https:' && config.TLS_METADATA_URL
      ? certificateExpiration(url.hostname, config.TLS_METADATA_URL, config.TLS_METADATA_TOKEN, signal)
        .catch(() => null)
      : null,
    domainExpiration(url.hostname, signal).catch(() => null),
  ])
  return { certificateExpiresAt, domainExpiresAt }
}
