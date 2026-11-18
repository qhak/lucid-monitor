import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readExpiration } from '../server/metadata'
import { runProbe, safeFetch, validateTarget } from '../server/probe'

afterEach(() => vi.restoreAllMocks())

const config = {
  url: 'https://www.example.com/status',
  method: 'GET' as const,
  expectedStatus: 200,
  timeoutMs: 1_000,
  expectedContent: 'healthy',
}

function mockProbe(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
  ipv4 = '93.184.216.34',
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name')
      const isV4 = url.searchParams.get('type') === 'A'
      const type = isV4 ? 1 : 28
      return Response.json({
        Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
        Question: [{ name, type }],
        Answer: isV4 ? [{ name, type, TTL: 300, data: ipv4 }] : [],
      })
    }
    return handler(url, init)
  }
}

test('accepts only an exact configured DNS hostname', () => {
  assert.equal(validateTarget(config.url, 'www.example.com').hostname, 'www.example.com')
  assert.throws(() => validateTarget(config.url, 'example.com'))
  assert.throws(() => validateTarget(config.url, '*.example.com'))
  assert.throws(() => validateTarget('https://93.184.216.34/', '93.184.216.34'))
  assert.throws(() => validateTarget('https:www.example.com/status', 'www.example.com'))
  assert.throws(() => validateTarget('https://@www.example.com/', 'www.example.com'))
})

test('requires the exact HTTP status and body substring across stream chunks', async () => {
  const encoder = new TextEncoder()
  const response = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('heal'))
      controller.enqueue(encoder.encode('thy'))
      controller.close()
    },
  }), { status: 201 })
  assert.equal((await runProbe(config, 'www.example.com', mockProbe(response))).ok, false)
  assert.equal((await runProbe({ ...config, expectedStatus: 201 }, 'www.example.com', mockProbe(response))).ok, true)
  assert.equal((await runProbe({ ...config, expectedStatus: 201, expectedContent: 'missing' }, 'www.example.com', mockProbe(response))).ok, false)
})

test('validates every redirect before requesting it', async () => {
  const requests: string[] = []
  const fetcher = mockProbe((url, init) => {
    requests.push(url.hostname)
    assert.equal(init?.redirect, 'manual')
    return new Response(null, { status: 302, headers: { location: 'https://unapproved.example.com/' } })
  })
  const result = await runProbe(config, 'www.example.com', fetcher)
  assert.equal(result.ok, false)
  assert.deepEqual(requests, ['www.example.com'])
})

test('fails closed before a request when DNS resolves to a nonpublic address', async () => {
  let requested = false
  const result = await runProbe(config, 'www.example.com', mockProbe(() => {
    requested = true
    return new Response('healthy')
  }, '10.0.0.5'))
  assert.equal(result.ok, false)
  assert.equal(requested, false)
})

test('sends POST without following redirects by default', async () => {
  const requests: string[] = []
  const fetcher = mockProbe((url, init) => {
    requests.push(url.pathname)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'manual')
    return new Response(null, { status: 307, headers: { location: '/new' } })
  })
  assert.equal((await safeFetch(config.url, 'www.example.com', { method: 'POST' }, { fetcher })).status, 307)
  assert.deepEqual(requests, ['/status'])
})

test('reports a timeout when response headers arrive but the content stalls', async () => {
  const fetcher = mockProbe(() => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })))
  const result = await runProbe({ ...config, timeoutMs: 25 }, 'www.example.com', fetcher)
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 200)
  assert.match(result.error ?? '', /timed out/i)
})

test('rejects a streamed response over the body limit with no content-length header', async () => {
  const fetcher = mockProbe(() => new Response('healthy'.padEnd(1024 * 1024 + 1, ' ')))
  const result = await runProbe(config, 'www.example.com', fetcher)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /too large/i)
})

test('reports IANA registry expiry for the registrable domain', async () => {
  const requests: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(mockProbe((url, init) => {
    requests.push(url.href)
    assert.equal(init?.redirect, 'manual')
    if (url.hostname === 'data.iana.org') {
      return Response.json({ version: '1.0', services: [[['uk'], ['https://registry.example.com/rdap/']]] })
    }
    if (url.hostname === 'registry.example.com') {
      return Response.json({
        objectClassName: 'domain', ldhName: 'example.co.uk',
        events: [{ eventAction: 'expiration', eventDate: '2030-02-01T00:00:00Z' }],
      })
    }
    throw new Error('Unexpected HTTP request')
  }))
  assert.deepEqual(await readExpiration('https://app.example.co.uk/secret', {}), {
    certificateExpiresAt: null, domainExpiresAt: 1_896_134_400_000,
  })
  assert.deepEqual(requests, [
    'https://data.iana.org/rdap/dns.json', 'https://registry.example.com/rdap/domain/example.co.uk',
  ])
})

test('reports certificate expiry only for the requested TLS hostname', async () => {
  const { TLS_METADATA_URL, TLS_METADATA_TOKEN } = {
    TLS_METADATA_URL: 'https://inspector.example.com/expiry',
    TLS_METADATA_TOKEN: 'token',
  }
  let reportedHostname = 'www.example.com'
  vi.spyOn(globalThis, 'fetch').mockImplementation(mockProbe((url, init) => {
    if (url.hostname === 'data.iana.org') return Response.json({ services: [] })
    assert.equal(url.origin, 'https://inspector.example.com')
    assert.equal(url.pathname, '/expiry')
    assert.equal(url.search, '?hostname=www.example.com')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token')
    return Response.json({ hostname: reportedHostname, certificateExpiresAt: '2030-02-01T00:00:00Z' })
  }))
  const settings = { TLS_METADATA_URL, TLS_METADATA_TOKEN }
  assert.equal((await readExpiration(config.url, settings)).certificateExpiresAt, 1_896_134_400_000)
  reportedHostname = 'other.example.com'
  assert.equal((await readExpiration(config.url, settings)).certificateExpiresAt, null)
})

test('follows approved redirects and never forwards headers to a different origin', async () => {
  const fetcher = mockProbe((url, init) => {
    if (url.hostname === 'www.example.com') {
      return new Response(null, { status: 301, headers: { location: 'https://health.example.com/' } })
    }
    assert.equal(url.hostname, 'health.example.com')
    assert.deepEqual([...new Headers(init?.headers)], [])
    return new Response('healthy')
  })
  const response = await safeFetch(config.url, 'www.example.com, health.example.com', {
    method: 'GET',
    headers: { Authorization: 'Bearer test', Cookie: 'test=true' },
  }, { redirects: 3, fetcher })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'healthy')
})
test('leaves domain expiry unknown on shared hosting suffixes', async () => {
  const requests: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requests.push(String(input))
    return Response.json({})
  })
  assert.deepEqual(await readExpiration('https://project.pages.dev/', {}), {
    certificateExpiresAt: null, domainExpiresAt: null,
  })
  assert.deepEqual(requests, [])
})
