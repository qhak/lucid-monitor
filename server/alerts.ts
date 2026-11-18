import { safeFetch, validateTarget } from './probe'

type AlertKind = 'email' | 'discord' | 'webhook'

interface AlertEnv {
  DB: D1Database
  ALERT_ENCRYPTION_KEY?: string
  OUTBOUND_HOSTS?: string
  EMAIL?: { send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> }
  EMAIL_FROM?: string
}

const discordHost = 'discord.com'
const maxAttempts = 5
const leaseMs = 120_000

function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function destinationKey(secret: string) {
  const bytes = base64Bytes(secret)
  if (bytes.length !== 32) throw new Error('The alert encryption key must contain 32 base64-encoded bytes.')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptDestination(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await destinationKey(secret), new TextEncoder().encode(value))
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}

async function decryptDestination(key: CryptoKey, value: string) {
  const [version, iv, ciphertext, extra] = value.split('.')
  if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted destination.')
  return new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64Bytes(iv) }, key, base64Bytes(ciphertext),
  ))
}

export function validateDestination(kind: AlertKind, value: string, allowedHosts: string): void {
  if (!value || value.length > 2048 || value.trim() !== value || /[\r\n\t]/.test(value)) {
    throw new Error('Enter a valid alert destination.')
  }
  if (kind === 'email') {
    const [local] = value.split('@')
    const email = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
    if (value.length > 254 || local.length > 64 || !email.test(value)) throw new Error('Enter one valid email address.')
    return
  }
  const url = validateTarget(value, kind === 'discord' ? discordHost : allowedHosts)
  if (url.protocol !== 'https:') throw new Error('Alert webhooks require HTTPS.')
  if (kind === 'discord' && (value.includes('?') || !/^\/api(?:\/v10)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]+$/.test(url.pathname))) {
    throw new Error('Enter a Discord webhook URL copied from the channel settings.')
  }
}

type ClaimedAlert = { channel_id: string; attempts: number; event_kind: string; payload: string }
type AlertChannel = { kind: AlertKind; encrypted_destination: string }
type DeliveryResult = { error: string; retryable: boolean; retryAfterMs?: number }

async function deliver(env: AlertEnv, id: string, delivery: ClaimedAlert, channel: AlertChannel): Promise<DeliveryResult | null> {
  let key: CryptoKey
  try {
    if (!env.ALERT_ENCRYPTION_KEY) throw new Error()
    key = await destinationKey(env.ALERT_ENCRYPTION_KEY)
  } catch {
    return { error: 'Alert encryption is not configured.', retryable: true }
  }

  let destination: string
  const allowedHosts = env.OUTBOUND_HOSTS ?? ''
  try {
    destination = await decryptDestination(key, channel.encrypted_destination)
    validateDestination(channel.kind, destination, allowedHosts)
  } catch {
    return { error: 'The alert destination is invalid or unavailable.', retryable: false }
  }

  const payload = JSON.parse(delivery.payload) as { monitorName?: unknown; title?: unknown; incidentId?: unknown } | null
  if (typeof payload?.monitorName !== 'string' || typeof payload.title !== 'string' || typeof payload.incidentId !== 'string') {
    return { error: 'The alert payload is invalid.', retryable: false }
  }
  const subject = `Lucid Monitor: ${payload.monitorName} (${delivery.event_kind})`.replace(/[\r\n]+/g, ' ').slice(0, 180)
  const message = `${subject}\n${payload.title}\nIncident ${payload.incidentId}`

  try {
    if (channel.kind === 'email') {
      if (!env.EMAIL || !env.EMAIL_FROM) return { error: 'Email sending is not configured.', retryable: true }
      await env.EMAIL.send({ from: env.EMAIL_FROM, to: destination, subject, text: message })
      return null
    }

    const discord = channel.kind === 'discord'
    const url = new URL(destination)
    if (discord) url.searchParams.set('wait', 'true')
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (!discord) headers.set('Idempotency-Key', id)
    const response = await safeFetch(url.href, discord ? discordHost : allowedHosts, {
      method: 'POST',
      headers,
      body: discord
        ? JSON.stringify({ content: message.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 })
        : delivery.payload,
      signal: AbortSignal.timeout(10_000),
    })
    void response.body?.cancel().catch(() => {})
    if (response.ok) return null

    const retryAfter = response.headers.get('Retry-After')
    const seconds = Number(retryAfter)
    const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? '') - Date.now()
    return {
      error: `Alert provider returned HTTP ${response.status}.`,
      retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
      retryAfterMs: Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 86_400_000) : undefined,
    }
  } catch {
    return { error: 'Could not reach the alert provider.', retryable: true }
  }
}

const due = "((status = 'pending' AND next_at <= ?2) OR (status = 'sending' AND lease_until <= ?2))"
const sameCooldown = `prior.channel_id = alert_deliveries.channel_id
  AND prior.monitor_id = alert_deliveries.monitor_id AND prior.event_kind = alert_deliveries.event_kind
  AND prior.id != alert_deliveries.id AND channel.cooldown_seconds > 0`
const recentlySent = "(prior.status = 'sent' AND prior.sent_at > ?2 - channel.cooldown_seconds * 1000)"

// If the provider accepts a message before its final DB update, the next lease holder can send it again.
export async function processAlert(env: AlertEnv, id: string): Promise<void> {
  const now = Date.now()
  const claim = await env.DB.prepare(`
    UPDATE alert_deliveries
    SET status = 'sending', attempts = attempts + 1, lease_until = ?4, error = NULL
    WHERE id = ?1 AND ${due} AND attempts < ?3
      AND NOT EXISTS (
        SELECT 1 FROM alert_deliveries prior JOIN alert_channels channel ON channel.id = prior.channel_id
        WHERE ${sameCooldown} AND (${recentlySent} OR (prior.status = 'sending' AND prior.lease_until > ?2))
      )
    RETURNING channel_id, attempts, event_kind, payload
  `).bind(id, now, maxAttempts, now + leaseMs).first<ClaimedAlert>()

  if (!claim) {
    await env.DB.prepare(`
      UPDATE alert_deliveries
      SET status = CASE WHEN attempts >= ?3 THEN 'failed' ELSE 'suppressed' END,
        error = CASE WHEN attempts >= ?3 THEN 'Alert delivery attempts exhausted.' ELSE NULL END,
        lease_until = 0
      WHERE id = ?1 AND ${due} AND (attempts >= ?3 OR EXISTS (
        SELECT 1 FROM alert_deliveries prior JOIN alert_channels channel ON channel.id = prior.channel_id
        WHERE ${sameCooldown} AND ${recentlySent}
      ))
    `).bind(id, now, maxAttempts).run()
    return
  }

  const channel = await env.DB.prepare('SELECT kind, encrypted_destination FROM alert_channels WHERE id = ?')
    .bind(claim.channel_id).first<AlertChannel>()
  if (!channel) return

  const result = await deliver(env, id, claim, channel)
  const completedAt = Date.now()
  const retry = result?.retryable && claim.attempts < maxAttempts
  const delay = Math.max(30_000 * 2 ** (claim.attempts - 1), result?.retryAfterMs ?? 0)
  const status = result ? (retry ? 'pending' : 'failed') : 'sent'
  await env.DB.prepare(`
    UPDATE alert_deliveries SET status = ?, next_at = ?, lease_until = 0, error = ?, sent_at = ?
    WHERE id = ? AND status = 'sending' AND attempts = ?
  `).bind(status, retry ? completedAt + delay : completedAt, result?.error ?? null, result ? null : completedAt, id, claim.attempts).run()
}
