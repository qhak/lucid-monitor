import type { AuthSettings } from './auth';

export type State = 'operational' | 'degraded' | 'down' | 'paused' | 'unknown';
export type CheckJob = { type: 'check'; monitorId: string; generation: number; scheduledAt: number };
export type AlertJob = { type: 'alert'; id: string };
export type Job = CheckJob | AlertJob;
export type Env = AuthSettings & {
  SCHEDULER: DurableObjectNamespace;
  CHECK_QUEUE: Queue<CheckJob>;
  ALERT_QUEUE: Queue<AlertJob>;
  OUTBOUND_HOSTS?: string;
  ALERT_ENCRYPTION_KEY?: string;
  EMAIL?: { send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
  EMAIL_FROM?: string;
  TLS_METADATA_URL?: string;
  TLS_METADATA_TOKEN?: string;
  API_LIMIT?: RateLimit;
  AUTH_LIMIT?: RateLimit;
  DEBUG_LOGGING?: string;
};
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const roundMinute = (time: number) => Math.floor(time / 60000) * 60000;
export const nextMinute = (time: number) => roundMinute(time) + 60000;
export const monitorColumns = `
  m.id,m.name,m.url,m.state,m.interval_seconds AS intervalSeconds,m.method,
  m.expected_status AS expectedStatus,m.timeout_ms AS timeoutMs,m.expected_content AS expectedContent,
  m.failure_threshold AS failureThreshold,m.recovery_threshold AS recoveryThreshold,
  m.slow_ms AS slowMs,m.alerts_enabled AS alertsEnabled,m.last_checked_at AS lastCheckedAt,
  m.last_success AS lastSuccess,m.last_failure AS lastFailure,
  m.certificate_expires_at AS certificateExpiresAt,m.domain_expires_at AS domainExpiresAt,
  EXISTS(SELECT 1 FROM incidents i WHERE i.monitor_id=m.id AND i.resolved_at IS NULL) AS activeIncident`;
export type Monitor = {
  id: string; name: string; url: string; state: State; intervalSeconds: number;
  method: 'GET' | 'HEAD'; expectedStatus: number; timeoutMs: number; expectedContent: string | null;
  failureThreshold: number; recoveryThreshold: number; slowMs: number; alertsEnabled: number;
  lastCheckedAt: number | null; lastSuccess: number | null; lastFailure: number | null;
  certificateExpiresAt: number | null; domainExpiresAt: number | null; activeIncident: number;
};
export function presentMonitor(monitor: Monitor) {
  return { ...monitor, alertsEnabled: Boolean(monitor.alertsEnabled), activeIncident: Boolean(monitor.activeIncident) };
}
