import ipaddr from 'ipaddr.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_RESPONSE_BYTES = 1024 * 1024
const DNS_RESPONSE_BYTES = 64 * 1024
const DNS_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

class ProbeError extends Error {}

export function validateTarget(input: string, allowedHosts: string): URL {
  const authority = /^https?:\/\/([^/?#\\]+)/i.exec(input.trim())?.[1]
  if (!authority || authority.includes('@') || input.includes('\\')) {
    throw new ProbeError('Enter a valid HTTP or HTTPS URL without credentials.')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ProbeError('Enter a valid HTTP or HTTPS URL.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.port || input.includes('#') || !DNS_HOSTNAME.test(url.hostname) || ipaddr.isValid(url.hostname)
  ) {
    throw new ProbeError('Use an HTTP or HTTPS URL with a public DNS hostname and the default port.')
  }
  const approved = allowedHosts.toLowerCase().split(/[\s,]+/)
  if (!approved.includes(url.hostname)) {
    throw new ProbeError('This hostname is not on the approved host list.')
  }
  return url
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

export async function readBoundedText(
  response: Response,
  limit: number,
  signal?: AbortSignal | null,
): Promise<string> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    discardBody(response)
    throw new ProbeError('Response body is too large.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let length = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new ProbeError('Response body is too large.')
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export function isPublicAddress(value: unknown, type: number): boolean {
  if (typeof value !== 'string' || !ipaddr.isValid(value)) return false
  const address = ipaddr.parse(value)
  if (address.range() !== 'unicast') return false
  if (address instanceof ipaddr.IPv6) {
    return type === 28 && address.match(ipaddr.IPv6.parse('2000::'), 3)
  }
  return type === 1
}

async function validateDns(hostname: string, fetcher: typeof fetch, signal?: AbortSignal | null) {
  const counts = await Promise.all(['A', 'AAAA'].map(async (type) => {
    const url = new URL('https://cloudflare-dns.com/dns-query')
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', type)
    let result: { Status?: unknown; TC?: unknown; Answer?: unknown } | null
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/dns-json' },
        redirect: 'manual',
        signal,
      })
      if (!response.ok) {
        discardBody(response)
        throw new Error()
      }
      result = JSON.parse(await readBoundedText(response, DNS_RESPONSE_BYTES, signal))
    } catch {
      throw new ProbeError('Public DNS lookup failed.')
    }
    if (!result || result.Status !== 0 || result.TC === true ||
      (result.Answer !== undefined && !Array.isArray(result.Answer))) {
      throw new ProbeError('Public DNS lookup failed.')
    }
    let addresses = 0
    for (const answer of result.Answer ?? []) {
      if (answer?.type !== 1 && answer?.type !== 28) continue
      if (!isPublicAddress(answer.data, answer.type)) {
        throw new ProbeError('This hostname resolves to a nonpublic address.')
      }
      addresses++
    }
    return addresses
  }))
  if (counts.every(count => count === 0)) throw new ProbeError('Hostname has no public DNS address.')
}

export async function safeFetch(
  input: string,
  allowedHosts: string,
  init: RequestInit,
  options: { redirects?: number; fetcher?: typeof fetch } = {},
): Promise<Response> {
  const { redirects = 0, fetcher = fetch } = options
  let url = validateTarget(input, allowedHosts)
  const method = init.method ?? 'GET'
  let headers = new Headers(init.headers)
  headers.delete('Host')
  for (let hop = 0; ; hop++) {
    init.signal?.throwIfAborted()
    // Workers resolve fetch independently. Configure only operator-trusted hostnames and DNS.
    await validateDns(url.hostname, fetcher, init.signal)
    init.signal?.throwIfAborted()
    const response = await fetcher(url, { ...init, headers, redirect: 'manual' })
    const location = response.headers.get('Location')
    if (!redirects || !['GET', 'HEAD'].includes(method) || !REDIRECT_STATUSES.has(response.status) || !location) {
      return response
    }
    discardBody(response)
    if (hop >= redirects) throw new ProbeError('Too many HTTP redirects.')
    let nextUrl: URL
    try {
      nextUrl = new URL(location, url)
    } catch {
      throw new ProbeError('Invalid HTTP redirect.')
    }
    if (nextUrl.origin !== url.origin) {
      // Never forward request credentials to a different origin.
      headers = new Headers()
    }
    url = validateTarget(nextUrl.href, allowedHosts)
  }
}

export async function runProbe(config: {
  url: string
  method: 'GET' | 'HEAD'
  expectedStatus: number
  timeoutMs: number
  expectedContent: string | null
}, allowedHosts: string, fetcher: typeof fetch = fetch): Promise<{
  ok: boolean
  latencyMs: number
  httpStatus: number | null
  error: string | null
}> {
  const startedAt = Date.now()
  const controller = new AbortController()
  let httpStatus: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProbeError('Request timed out.'))
    }, config.timeoutMs)
  })
  const execute = async () => {
    const response = await safeFetch(config.url, allowedHosts, {
      method: config.method,
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: '*/*' },
    }, { fetcher, redirects: REDIRECT_STATUSES.has(config.expectedStatus) ? 0 : 3 })
    controller.signal.throwIfAborted()
    httpStatus = response.status
    if (httpStatus !== config.expectedStatus) {
      discardBody(response)
      throw new ProbeError(`Expected HTTP ${config.expectedStatus}, received HTTP ${httpStatus}.`)
    }
    if (!config.expectedContent) {
      discardBody(response)
      return
    }
    const body = await readBoundedText(response, MAX_RESPONSE_BYTES, controller.signal)
    if (!body.includes(config.expectedContent)) throw new ProbeError('Expected content was not found.')
  }
  try {
    await Promise.race([execute(), deadline])
    return { ok: true, httpStatus, latencyMs: Date.now() - startedAt, error: null }
  } catch (error) {
    return {
      ok: false,
      httpStatus,
      latencyMs: Date.now() - startedAt,
      error: error instanceof ProbeError ? error.message : 'Request failed.',
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
