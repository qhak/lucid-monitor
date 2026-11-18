import { DAY, HOUR, type State } from './model';

export const periods = { '24h': [24, HOUR], '7d': [7 * 24, HOUR], '30d': [30, DAY], '90d': [90, DAY] } as const;
export type Period = keyof typeof periods;
export type Totals = { passed: number; failed: number; missing: number; latencyCount: number; latencySum: number };
type Aggregate = Totals & { time: number };
export const metricColumns = `
  COALESCE(SUM(passed),0) AS passed, COALESCE(SUM(failed),0) AS failed,
  COALESCE(SUM(missing),0) AS missing, COALESCE(SUM(latency_count),0) AS latencyCount,
  COALESCE(SUM(latency_sum),0) AS latencySum`;
const emptyTotals = { passed: 0, failed: 0, missing: 0, latencyCount: 0, latencySum: 0 };

export function averages(totals: Totals) {
  const checked = totals.passed + totals.failed;
  return {
    uptime: checked ? 100 * totals.passed / checked : null,
    avgLatency: totals.latencyCount ? totals.latencySum / totals.latencyCount : null,
    checked, missed: totals.missing,
  };
}

export function percentile(histogram: { bucket: number; samples: number }[], quantile: number) {
  const rank = Math.ceil(histogram.reduce((sum, row) => sum + row.samples, 0) * quantile);
  if (!rank) return null;
  let samples = 0;
  for (const row of histogram) {
    samples += row.samples;
    if (samples >= rank) return row.bucket;
  }
  return null;
}

export function windowFor(period: Period, now = Date.now()) {
  const [count, step] = periods[period];
  const start = Math.floor(now / step) * step - (count - 1) * step;
  return { count, step, start, now };
}

export async function seriesFor(db: D1Database, scope: { monitorId: string } | { userId: string }, period: Period, now = Date.now()) {
  const window = windowFor(period, now);
  const ownerScope = 'userId' in scope;
  const rows = await db.prepare(`
    SELECT CAST(hour/?1 AS INTEGER)*?1 AS time,${metricColumns} FROM aggregates
    ${ownerScope ? 'JOIN monitors m ON m.id=aggregates.monitor_id' : ''}
    WHERE ${ownerScope ? 'm.user_id' : 'monitor_id'}=?2 AND hour>=?3 GROUP BY 1
  `).bind(window.step, ownerScope ? scope.userId : scope.monitorId, window.start).all<Aggregate>();
  const byTime = new Map(rows.results.map((row) => [row.time, row]));
  return Array.from({ length: window.count }, (_, index) => {
    const time = window.start + index * window.step;
    const { passed, failed, missing, latencyCount, latencySum } = byTime.get(time) ?? emptyTotals;
    return { time, passed, failed, missing, avgLatency: latencyCount ? latencySum / latencyCount : null };
  });
}

export async function monitorMetrics(db: D1Database, monitorId: string, period: Period, now = Date.now()) {
  const { start } = windowFor(period, now);
  const [totals, histogram, incidents] = await Promise.all([
    db.prepare(`SELECT ${metricColumns} FROM aggregates WHERE monitor_id=? AND hour>=?`)
      .bind(monitorId, start).first<Totals>(),
    db.prepare('SELECT bucket,SUM(samples) AS samples FROM latency_histogram WHERE monitor_id=? AND hour>=? GROUP BY bucket ORDER BY bucket')
      .bind(monitorId, start).all<{ bucket: number; samples: number }>(),
    db.prepare(`SELECT SUM(opened_at>=?2) AS incidentFrequency,
      AVG(CASE WHEN resolved_at>=?2 THEN (resolved_at-opened_at)/1000.0 END) AS mttrSeconds,
      COALESCE(SUM(MAX(0,MIN(COALESCE(resolved_at,?3),?3)-MAX(opened_at,?2)))/1000.0,0) AS downtimeSeconds
      FROM incidents WHERE monitor_id=?1 AND opened_at<=?3 AND (resolved_at IS NULL OR resolved_at>=?2)`)
      .bind(monitorId, start, now).first<{ incidentFrequency: number | null; mttrSeconds: number | null; downtimeSeconds: number }>(),
  ]);
  return {
    ...averages(totals ?? emptyTotals),
    p50: percentile(histogram.results, 0.5), p95: percentile(histogram.results, 0.95), p99: percentile(histogram.results, 0.99),
    incidentFrequency: incidents?.incidentFrequency ?? 0, mttrSeconds: incidents?.mttrSeconds ?? null,
    downtimeSeconds: incidents?.downtimeSeconds ?? 0,
  };
}

export function overallState(states: State[]): State {
  for (const state of ['down', 'degraded', 'unknown'] as const) {
    if (states.includes(state)) return state;
  }
  if (states.includes('operational')) return 'operational';
  return states.length ? 'paused' : 'unknown';
}
