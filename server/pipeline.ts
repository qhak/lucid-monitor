import { DurableObject } from 'cloudflare:workers';
import { processAlert } from './alerts';
import { readExpiration } from './metadata';
import { DAY, roundMinute, type AlertJob, type CheckJob, type Env, type Job, type Monitor } from './model';
import { runProbe } from './probe';

const staleAfter = 120000;
const historyLimit = 5000;
type CheckConfig = Pick<Monitor, 'url' | 'method' | 'expectedStatus' | 'timeoutMs' | 'expectedContent'>;

async function rollForwardMisses(db: D1Database, minute: number) {
  const overdue = `overdue AS (
    SELECT id,next_due,interval_seconds*1000 AS step,
      next_due+CAST((?1-next_due)/(interval_seconds*1000) AS INTEGER)*interval_seconds*1000 AS resumed
    FROM monitors WHERE state<>'paused' AND next_due<=?1-4*interval_seconds*1000
    ORDER BY next_due,id LIMIT 200
  )`;
  // Roll long gaps into hourly counts so catch-up does not starve fresh probes.
  await db.batch([
    db.prepare(`
      WITH RECURSIVE ${overdue},
      recent AS (
        SELECT id,step,resumed,next_due+MAX(0,CAST((?2-next_due+step-1)/step AS INTEGER))*step AS first
        FROM overdue
      ),
      hours(id,step,resumed,first,hour) AS (
        SELECT id,step,resumed,first,first/3600000*3600000 FROM recent WHERE first<resumed
        UNION ALL SELECT id,step,resumed,first,hour+3600000 FROM hours WHERE hour+3600000<resumed
      ),
      buckets AS (
        SELECT id,hour,(MIN(resumed,hour+3600000)-first+step-1)/step
          -MAX(0,(hour-first+step-1)/step) AS missed
        FROM hours
      )
      INSERT INTO aggregates(monitor_id,hour,passed,failed,missing,latency_count,latency_sum)
      SELECT id,hour,0,0,missed,0,0 FROM buckets WHERE missed>0
      ON CONFLICT(monitor_id,hour) DO UPDATE SET missing=missing+excluded.missing
    `).bind(minute, minute - DAY),
    db.prepare(`
      WITH ${overdue}
      UPDATE monitors SET next_due=overdue.resumed,
        last_slot=MAX(COALESCE(last_slot,0),overdue.resumed-overdue.step),
        failure_streak=0,success_streak=0,
        state=CASE WHEN state='down' THEN 'down' ELSE 'unknown' END
      FROM overdue WHERE monitors.id=overdue.id
    `).bind(minute),
  ]);
}

export async function schedule(env: Env, timestamp: number) {
  const now = Date.now();
  const minute = roundMinute(timestamp);
  await rollForwardMisses(env.DB, minute);
  for (let pass = 0; pass < 4; pass++) {
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO checks(monitor_id,generation,scheduled_at,status,dispatch_at)
      SELECT id,generation,next_due,'pending',0 FROM monitors
      WHERE state<>'paused' AND next_due<=? ORDER BY next_due,id LIMIT 200
    `).bind(minute).run();
    if (!result.meta.changes) break;
  }

  await env.DB.prepare(`
    UPDATE checks SET status='missed',error='missed_schedule'
    WHERE (monitor_id,generation,scheduled_at) IN (
      SELECT monitor_id,generation,scheduled_at FROM checks
      WHERE status IN ('pending','running') AND scheduled_at<? AND lease_until<=?
      LIMIT 1000
    )
  `).bind(now - staleAfter, now).run();
  await env.DB.prepare(`
    UPDATE checks SET status='pending',claim=NULL,lease_until=0,dispatch_at=0
    WHERE status='running' AND lease_until<=? AND scheduled_at>=?
  `).bind(now, now - staleAfter).run();

  const [checks, alerts] = await Promise.all([
    env.DB.prepare(`
      SELECT monitor_id AS monitorId,generation,scheduled_at AS scheduledAt FROM checks
      WHERE status='pending' AND dispatch_at<=? AND scheduled_at>=?
      ORDER BY dispatch_at,scheduled_at LIMIT 300
    `).bind(now, now - staleAfter).all<Omit<CheckJob, 'type'>>(),
    env.DB.prepare(`
      SELECT id FROM alert_deliveries WHERE (status='pending' AND next_at<=?)
        OR (status='sending' AND lease_until<=?) ORDER BY next_at LIMIT 200
    `).bind(now, now).all<{ id: string }>(),
  ]);

  for (let offset = 0; offset < checks.results.length; offset += 75) {
    const chunk = checks.results.slice(offset, offset + 75);
    await env.CHECK_QUEUE.sendBatch(chunk.map((row) => ({ body: { type: 'check', ...row } })));
    await env.DB.batch(chunk.map((row) => env.DB.prepare(`
      UPDATE checks SET dispatch_at=? WHERE monitor_id=? AND generation=? AND scheduled_at=? AND status='pending'
    `).bind(now + 30000, row.monitorId, row.generation, row.scheduledAt)));
  }
  for (let offset = 0; offset < alerts.results.length; offset += 75) {
    const chunk = alerts.results.slice(offset, offset + 75);
    await env.ALERT_QUEUE.sendBatch(chunk.map(({ id }) => ({ body: { type: 'alert', id } })));
  }

  if (new Date(minute).getUTCMinutes() % 10 === 0) await prune(env.DB, now);
  if (env.DEBUG_LOGGING === 'true') {
    console.info(JSON.stringify({ event: 'schedule', checkJobs: checks.results.length, alertJobs: alerts.results.length }));
  }
}

async function prune(db: D1Database, now: number) {
  const cutoffs = [
    ['checks', 'scheduled_at', now - 7 * DAY],
    ['aggregates', 'hour', now - 91 * DAY],
    ['latency_histogram', 'hour', now - 91 * DAY],
    ['alert_deliveries', 'created_at', now - 30 * DAY],
  ] as const;
  await db.batch(cutoffs.map(([table, column, cutoff]) => db.prepare(`
    DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column}<? LIMIT ?)
  `).bind(cutoff, historyLimit)));
}

export class Scheduler extends DurableObject<Env> {
  async fetch(request: Request) {
    const timestamp = Number(new URL(request.url).searchParams.get('time'));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return new Response(null, { status: 400 });
    await this.ctx.blockConcurrencyWhile(() => schedule(this.env, timestamp));
    return new Response(null, { status: 204 });
  }
}

export async function executeCheck(env: Env, job: CheckJob, probe = runProbe) {
  const { monitorId, generation, scheduledAt } = job;
  const now = Date.now();
  const claim = crypto.randomUUID();
  // Do not execute stale work or let two deliveries probe the same slot simultaneously.
  const reserved = await env.DB.prepare(`
    UPDATE checks SET status='running',claim=?1,lease_until=?2
    WHERE monitor_id=?3 AND generation=?4 AND scheduled_at=?5 AND scheduled_at>=?6
      AND (status='pending' OR (status='running' AND lease_until<=?7))
    RETURNING scheduled_at
  `).bind(claim, now + 35000, monitorId, generation, scheduledAt, now - staleAfter, now).first();
  if (!reserved) return;

  const config = await env.DB.prepare(`
    SELECT url,method,expected_status AS expectedStatus,timeout_ms AS timeoutMs,
      expected_content AS expectedContent FROM monitors WHERE id=? AND generation=? AND state<>'paused'
  `).bind(monitorId, generation).first<CheckConfig>();
  const result = config ? await probe(config, env.OUTBOUND_HOSTS ?? '') : null;
  const finished = Date.now();
  await env.DB.prepare(`
    UPDATE checks SET status=?,checked_at=?,latency_ms=?,http_status=?,error=?,claim=NULL,lease_until=0
    WHERE monitor_id=? AND generation=? AND scheduled_at=? AND claim=? AND status='running'
  `).bind(result ? result.ok ? 'ok' : 'failed' : 'missed', result ? finished : null,
    result?.httpStatus != null ? Math.round(result.latencyMs) : null, result?.httpStatus ?? null,
    result?.error ?? (config ? null : 'monitor_changed'), monitorId, generation, scheduledAt, claim).run();

  if (!config) return;
  const metadata = await env.DB.prepare(`
    UPDATE monitors SET metadata_due=? WHERE id=? AND generation=? AND metadata_due<=?
    RETURNING id
  `).bind(finished + DAY, monitorId, generation, finished).first();
  if (!metadata) return;
  try {
    const expiry = await readExpiration(config.url, env);
    await env.DB.prepare('UPDATE monitors SET certificate_expires_at=?,domain_expires_at=? WHERE id=? AND generation=?')
      .bind(expiry.certificateExpiresAt, expiry.domainExpiresAt, monitorId, generation).run();
  } catch {
    if (env.DEBUG_LOGGING === 'true') console.warn(JSON.stringify({ event: 'metadata_unavailable', monitorId }));
  }
}

export async function consume(batch: MessageBatch<Job>, env: Env) {
  const groups = [...batch.messages];
  // Two probes at a time leave headroom for DNS and response streams.
  while (groups.length) {
    await Promise.all(groups.splice(0, 2).map(async (message) => {
      const job = message.body;
      try {
        if (job.type === 'check') await executeCheck(env, job);
        if (job.type === 'alert') await processAlert(env, (job as AlertJob).id);
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: 'queue_job_failed', type: job.type, attempts: message.attempts }));
        message.retry({ delaySeconds: Math.min(300, 10 * 2 ** (message.attempts - 1)) });
      }
    }));
  }
}
