import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { encryptDestination, validateDestination } from './alerts';
import { averages, metricColumns, monitorMetrics, overallState, periods, seriesFor, windowFor, type Period, type Totals } from './analytics';
import { createAuth, matchesInvite } from './auth';
import { monitorColumns, nextMinute, presentMonitor, type Env, type Job, type Monitor, type State } from './model';
import { consume } from './pipeline';
import { validateTarget } from './probe';

export { Scheduler } from './pipeline';

type App = { Bindings: Env; Variables: { userId: string } };
type AppContext = Context<App>;
const app = new Hono<App>();
const json = <T>(c: AppContext, data: T, status: 200 | 201 = 200) => c.json({ data }, status);
const abort = (status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string): never => {
  throw new HTTPException(status, { message });
};
const owner = (c: AppContext) => c.get('userId');
const db = (c: AppContext) => c.env.DB;
const pathId = (c: AppContext) => c.req.param('id') ?? '';
const bool = (value: boolean) => Number(value);

async function body<T>(c: AppContext, schema: z.ZodType<T>) {
  const payload: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new HTTPException(422, { message: parsed.error.issues.map((i) => [i.path.join('.'), i.message].filter(Boolean).join(' · ')).join(' / ') });
  return parsed.data;
}

function page(c: AppContext, fallback = 50) {
  const { limit, offset } = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(fallback),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  }).parse(c.req.query());
  return { limit, offset };
}

function list<T>(c: AppContext, rows: T[], { limit, offset }: { limit: number; offset: number }) {
  if (rows.length > limit) c.header('X-Next-Offset', String(offset + limit));
  return json(c, rows.slice(0, limit));
}

const monitorFields = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2048),
  intervalSeconds: z.number().int().min(60).max(86400).multipleOf(60),
  method: z.enum(['GET', 'HEAD']),
  expectedStatus: z.number().int().min(100).max(599),
  timeoutMs: z.number().int().min(500).max(20000),
  expectedContent: z.string().max(1024).nullable(),
  failureThreshold: z.number().int().min(1).max(10),
  recoveryThreshold: z.number().int().min(1).max(10),
  slowMs: z.number().int().min(100).max(20000),
  alertsEnabled: z.boolean(),
}).strict();
const fields = monitorFields.shape;
const monitorSchema = monitorFields.extend({
  intervalSeconds: fields.intervalSeconds.default(60), method: fields.method.default('GET'),
  expectedStatus: fields.expectedStatus.default(200), timeoutMs: fields.timeoutMs.default(10000),
  expectedContent: fields.expectedContent.default(null), failureThreshold: fields.failureThreshold.default(3),
  recoveryThreshold: fields.recoveryThreshold.default(2), slowMs: fields.slowMs.default(2000),
  alertsEnabled: fields.alertsEnabled.default(true),
});

function monitorValues(input: z.output<typeof monitorSchema>, env: Env) {
  if (input.method === 'HEAD' && input.expectedContent) abort(422, 'Response content can only be checked with GET');
  let url: string;
  try {
    url = validateTarget(input.url, env.OUTBOUND_HOSTS ?? '').href;
  } catch {
    throw new HTTPException(422, { message: 'Use a public HTTP or HTTPS URL on an operator-approved hostname' });
  }
  return [
    input.name, url, input.intervalSeconds, input.method, input.expectedStatus, input.timeoutMs,
    input.expectedContent || null, input.failureThreshold, input.recoveryThreshold, input.slowMs,
    bool(input.alertsEnabled),
  ] as const;
}

async function findMonitor(c: AppContext) {
  const monitor = await db(c).prepare(`SELECT ${monitorColumns},m.revision FROM monitors m WHERE m.id=? AND m.user_id=?`)
    .bind(pathId(c), owner(c)).first<Monitor & { revision: number }>();
  if (!monitor) throw new HTTPException(404, { message: 'Monitor not found' });
  return monitor;
}

function monitorResponse(row: Monitor & { revision?: number }) {
  const { revision, ...monitor } = row;
  void revision;
  return presentMonitor(monitor);
}

const incidentFields = `i.id,i.monitor_id AS monitorId,m.name AS monitorName,i.title,
  i.opened_at AS openedAt,i.acknowledged_at AS acknowledgedAt,i.resolved_at AS resolvedAt,
  (SELECT json_group_array(json_object('kind',kind,'message',message,'createdAt',created_at))
    FROM (SELECT kind,message,created_at FROM incident_events WHERE incident_id=i.id ORDER BY created_at,id LIMIT 100)) AS events`;
type Incident = { id: string; monitorId: string; monitorName: string; title: string; openedAt: number; acknowledgedAt: number | null; resolvedAt: number | null; events: string };

function presentIncident(row: Incident) {
  return { ...row, durationSeconds: (Math.max(row.openedAt, row.resolvedAt ?? Date.now()) - row.openedAt) / 1000, events: JSON.parse(row.events) as unknown };
}

async function findIncident(c: AppContext) {
  const row = await db(c).prepare(`
    SELECT ${incidentFields} FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=? AND m.user_id=?
  `).bind(pathId(c), owner(c)).first<Incident>();
  if (!row) throw new HTTPException(404, { message: 'Incident not found' });
  return row;
}

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const authRoute = c.req.path.startsWith('/api/auth/');
  const limiter = authRoute ? c.env.AUTH_LIMIT : c.env.API_LIMIT;
  if (limiter && !(await limiter.limit({ key: ip })).success) abort(429, 'Too many requests');
  const origin = c.req.header('origin');
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (!c.env.AUTH_URL || origin !== new URL(c.env.AUTH_URL).origin) abort(403, 'Cross-origin requests are unavailable');
  }
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 32768, onError: () => abort(413, 'Request body is too large') }));

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const isSignUp = c.req.path === '/api/auth/sign-up/email';
  const registrationAllowed = isSignUp && await matchesInvite(c.env.REGISTRATION_KEY, c.req.header('x-registration-key'));
  if (isSignUp && !registrationAllowed) abort(403, 'A valid registration key is required');
  return createAuth(c.env, registrationAllowed).handler(c.req.raw);
});

const statusPageSchema = z.object({
  title: z.string().trim().min(1).max(100),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().trim().max(500).default(''),
  monitorIds: z.array(z.string().min(1).max(64)).min(1).max(20)
    .refine((items) => new Set(items).size === items.length, 'Select each monitor once'),
}).strict();

app.get('/api/public/:slug', async (c) => {
  const publicPage = await db(c).prepare('SELECT id,title,description FROM status_pages WHERE slug=?')
    .bind(c.req.param('slug')).first<{ id: string; title: string; description: string }>();
  if (!publicPage) throw new HTTPException(404, { message: 'Status page not found' });
  const now = Date.now();
  const { start } = windowFor('90d', now);
  const [selected, incidents] = await Promise.all([
    db(c).prepare(`
      SELECT m.id,m.name,m.state FROM status_page_monitors spm JOIN monitors m ON m.id=spm.monitor_id
      WHERE spm.page_id=? ORDER BY spm.position
    `).bind(publicPage.id).all<{ id: string; name: string; state: State }>(),
    db(c).prepare(`
      SELECT i.id,m.name AS monitorName,'Availability incident' AS title,
        i.opened_at AS openedAt,i.resolved_at AS resolvedAt
      FROM status_page_monitors spm JOIN monitors m ON m.id=spm.monitor_id JOIN incidents i ON i.monitor_id=m.id
      WHERE spm.page_id=? AND (i.resolved_at IS NULL OR i.resolved_at>=?)
      ORDER BY i.resolved_at IS NOT NULL,i.opened_at DESC LIMIT 30
    `).bind(publicPage.id, start).all<{ resolvedAt: number | null }>(),
  ]);
  const monitors = await Promise.all(selected.results.map(async (m) => {
    const series = await seriesFor(db(c), { monitorId: m.id }, '90d', now);
    const passed = series.reduce((sum, b) => sum + b.passed, 0);
    const checked = series.reduce((sum, b) => sum + b.passed + b.failed, 0);
    return { ...m, uptime: checked ? 100 * passed / checked : null, series: series.map(({ time, passed, failed, missing }) => ({ time, passed, failed, missing })) };
  }));
  const monitorState = overallState(monitors.map((m) => m.state));
  const state = monitorState !== 'down' && incidents.results.some((incident) => incident.resolvedAt === null)
    ? 'degraded'
    : monitorState;
  return json(c, { title: publicPage.title, description: publicPage.description, state, monitors, incidents: incidents.results });
});

app.use('/api/*', async (c, next) => {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: 'Sign in to continue' });
  c.set('userId', session.user.id);
  await next();
});

app.get('/api/overview', async (c) => {
  const userId = owner(c);
  const now = Date.now();
  const [counts, totals, series] = await Promise.all([
    db(c).prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(state='operational'),0) AS operational,
        COALESCE(SUM(state='degraded'),0) AS degraded, COALESCE(SUM(state='down'),0) AS down,
        (SELECT COUNT(*) FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE m.user_id=?1 AND i.resolved_at IS NULL) AS activeIncidents
      FROM monitors WHERE user_id=?1
    `).bind(userId).first<Record<string, number>>(),
    db(c).prepare(`
      SELECT ${metricColumns} FROM aggregates a JOIN monitors m ON m.id=a.monitor_id WHERE m.user_id=? AND a.hour>=?
    `).bind(userId, windowFor('24h', now).start).first<Totals>(),
    seriesFor(db(c), { userId }, '24h', now),
  ]);
  return json(c, { ...counts, ...averages(totals!), series });
});

app.get('/api/monitors', async (c) => {
  const paging = page(c, 100);
  const rows = await db(c).prepare(`
    SELECT ${monitorColumns},
      (SELECT 100.0*SUM(passed)/NULLIF(SUM(passed+failed),0) FROM aggregates a WHERE a.monitor_id=m.id AND a.hour>=?1) AS uptime,
      (SELECT 1.0*SUM(latency_sum)/NULLIF(SUM(latency_count),0) FROM aggregates a WHERE a.monitor_id=m.id AND a.hour>=?1) AS avgLatency
    FROM monitors m WHERE m.user_id=?2 ORDER BY m.created_at DESC,m.id LIMIT ?3 OFFSET ?4
  `).bind(windowFor('24h').start, owner(c), paging.limit + 1, paging.offset).all<Monitor & { uptime: number | null; avgLatency: number | null }>();
  return list(c, rows.results.map(presentMonitor), paging);
});

app.post('/api/monitors', async (c) => {
  const values = monitorValues(await body(c, monitorSchema), c.env);
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await db(c).prepare(`
    INSERT INTO monitors (id,user_id,name,url,interval_seconds,method,expected_status,timeout_ms,expected_content,
      failure_threshold,recovery_threshold,slow_ms,alerts_enabled,next_due,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM monitors WHERE user_id=?)<100
    RETURNING id
  `).bind(id, owner(c), ...values, nextMinute(now), now, owner(c)).first();
  if (!inserted) abort(409, 'This account has reached the 100-monitor limit');
  return json(c, { id }, 201);
});

app.get('/api/monitors/:id', async (c) => {
  const monitor = await findMonitor(c);
  const period = z.enum(Object.keys(periods) as [Period, ...Period[]]).parse(c.req.query('period') ?? '24h');
  const now = Date.now();
  const [metrics, series, checks, incidents] = await Promise.all([
    monitorMetrics(db(c), monitor.id, period, now),
    seriesFor(db(c), { monitorId: monitor.id }, period, now),
    db(c).prepare(`
      SELECT scheduled_at AS scheduledAt,checked_at AS checkedAt,
        CASE status WHEN 'ok' THEN 1 WHEN 'failed' THEN 0 END AS ok,
        latency_ms AS latencyMs,http_status AS httpStatus,error
      FROM checks WHERE monitor_id=? AND scheduled_at>=? AND status IN ('ok','failed','missed')
      ORDER BY scheduled_at DESC LIMIT 50
    `).bind(monitor.id, windowFor(period, now).start).all<{ ok: number | null }>(),
    db(c).prepare(`SELECT ${incidentFields} FROM incidents i JOIN monitors m ON m.id=i.monitor_id
      WHERE i.monitor_id=? ORDER BY i.opened_at DESC,i.id LIMIT 30`).bind(monitor.id).all<Incident>(),
  ]);
  return json(c, { monitor: { ...monitorResponse(monitor), uptime: metrics.uptime, avgLatency: metrics.avgLatency }, metrics, series,
    checks: checks.results.map((row) => ({ ...row, ok: row.ok === null ? null : Boolean(row.ok) })),
    incidents: incidents.results.map(presentIncident), lastSuccess: monitor.lastSuccess, lastFailure: monitor.lastFailure });
});

app.get('/api/monitors/:id/status', async (c) => json(c, monitorResponse(await findMonitor(c))));
app.get('/api/monitors/:id/history', async (c) => {
  const monitor = await findMonitor(c);
  const period = z.enum(Object.keys(periods) as [Period, ...Period[]]).parse(c.req.query('period') ?? '24h');
  return json(c, await seriesFor(db(c), { monitorId: monitor.id }, period));
});
app.get('/api/monitors/:id/metrics', async (c) => {
  const monitor = await findMonitor(c);
  const period = z.enum(Object.keys(periods) as [Period, ...Period[]]).parse(c.req.query('period') ?? '24h');
  return json(c, await monitorMetrics(db(c), monitor.id, period));
});

app.patch('/api/monitors/:id', async (c) => {
  const existing = await findMonitor(c);
  const input = await body(c, monitorFields.partial());
  const merged = { ...monitorFields.strip().parse(monitorResponse(existing)), ...input };
  const values = monitorValues(merged, c.env);
  const changedProbe = values.slice(1, 10).some((value, i) => value !== [
    existing.url, existing.intervalSeconds, existing.method, existing.expectedStatus, existing.timeoutMs,
    existing.expectedContent, existing.failureThreshold, existing.recoveryThreshold, existing.slowMs,
  ][i]);
  const urlChanged = values[1] !== existing.url;
  const reset = changedProbe ? `
    , state=CASE WHEN state IN ('paused','down') THEN state ELSE 'unknown' END,
    generation=generation+1,next_due=?14,failure_streak=0,success_streak=0,last_slot=NULL
  ` : '';
  const metadataReset = urlChanged ? ', certificate_expires_at=NULL,domain_expires_at=NULL,metadata_due=0' : '';
  const result = await db(c).prepare(`
    UPDATE monitors SET name=?1,url=?2,interval_seconds=?3,method=?4,expected_status=?5,timeout_ms=?6,expected_content=?7,
      failure_threshold=?8,recovery_threshold=?9,slow_ms=?10,alerts_enabled=?11,revision=revision+1 ${reset} ${metadataReset}
    WHERE id=?12 AND user_id=?13 AND revision=${changedProbe ? '?15' : '?14'} RETURNING id
  `).bind(...values, existing.id, owner(c), ...(changedProbe ? [nextMinute(Date.now()), existing.revision] : [existing.revision])).first();
  if (!result) abort(409, 'The monitor changed while editing');
  return json(c, { id: existing.id });
});

for (const action of ['pause', 'resume'] as const) {
  app.post(`/api/monitors/:id/${action}`, async (c) => {
    const monitor = await findMonitor(c);
    const paused = action === 'pause';
    await db(c).prepare(`
      UPDATE monitors SET state=?,generation=generation+1,revision=revision+1,next_due=?,failure_streak=0,success_streak=0,last_slot=NULL
      WHERE id=? AND user_id=? AND state${paused ? '<>' : '='}'paused'
    `).bind(paused ? 'paused' : 'unknown', nextMinute(Date.now()), monitor.id, owner(c)).run();
    return json(c, { id: monitor.id });
  });
}

app.delete('/api/monitors/:id', async (c) => {
  const result = await db(c).prepare('DELETE FROM monitors WHERE id=? AND user_id=? RETURNING id').bind(pathId(c), owner(c)).first();
  if (!result) abort(404, 'Monitor not found');
  return json(c, result);
});

app.get('/api/incidents', async (c) => {
  const paging = page(c);
  const rows = await db(c).prepare(`
    SELECT ${incidentFields} FROM incidents i JOIN monitors m ON m.id=i.monitor_id
    WHERE m.user_id=? ORDER BY i.resolved_at IS NOT NULL,i.opened_at DESC,i.id LIMIT ? OFFSET ?
  `).bind(owner(c), paging.limit + 1, paging.offset).all<Incident>();
  return list(c, rows.results.map(presentIncident), paging);
});

app.post('/api/incidents', async (c) => {
  const input = await body(c, z.object({ monitorId: z.string().min(1).max(64), title: z.string().trim().min(1).max(150) }).strict());
  const monitor = await db(c).prepare('SELECT id FROM monitors WHERE id=? AND user_id=?').bind(input.monitorId, owner(c)).first();
  if (!monitor) abort(404, 'Monitor not found');
  const id = crypto.randomUUID();
  const inserted = await db(c).prepare('INSERT OR IGNORE INTO incidents(id,monitor_id,title,opened_at) VALUES(?,?,?,?) RETURNING id')
    .bind(id, input.monitorId, input.title, Date.now()).first();
  if (!inserted) abort(409, 'This monitor already has an active incident');
  return json(c, { id }, 201);
});

for (const action of ['acknowledge', 'resolve'] as const) {
  app.post(`/api/incidents/:id/${action}`, async (c) => {
    const incident = await findIncident(c);
    const column = action === 'acknowledge' ? 'acknowledged_at' : 'resolved_at';
    await db(c).prepare(`
      UPDATE incidents SET ${column}=MAX(opened_at,?) WHERE id=? AND ${column} IS NULL AND resolved_at IS NULL
    `).bind(Date.now(), incident.id).run();
    return json(c, presentIncident(await findIncident(c)));
  });
}

app.post('/api/incidents/:id/annotate', async (c) => {
  const incident = await findIncident(c);
  const { message } = await body(c, z.object({ message: z.string().trim().min(1).max(1000) }).strict());
  await db(c).prepare(`INSERT INTO incident_events(id,incident_id,kind,message,created_at)
    SELECT ?,?,'note',?,? WHERE (SELECT COUNT(*) FROM incident_events WHERE incident_id=? AND kind='note')<97`)
    .bind(crypto.randomUUID(), incident.id, message, Date.now(), incident.id).run().then((result) => {
      if (!result.meta.changes) abort(409, 'This incident has reached the note limit');
    });
  return json(c, presentIncident(await findIncident(c)), 201);
});

const channelFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['email', 'discord', 'webhook']),
  destination: z.string().trim().min(1).max(2048),
  events: z.array(z.enum(['opened', 'acknowledged', 'resolved'])).min(1).max(3),
  cooldownSeconds: z.number().int().min(0).max(86400),
}).strict();
const channelSchema = channelFieldsSchema.extend({
  events: channelFieldsSchema.shape.events.default(['opened', 'resolved']),
  cooldownSeconds: channelFieldsSchema.shape.cooldownSeconds.default(300),
});
const channelFields = 'id,name,kind,events,cooldown_seconds AS cooldownSeconds,created_at AS createdAt';

app.get('/api/channels', async (c) => {
  const paging = page(c);
  const rows = await db(c).prepare(`SELECT ${channelFields} FROM alert_channels WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
    .bind(owner(c), paging.limit + 1, paging.offset).all<{ events: string }>();
  return list(c, rows.results.map((row) => ({ ...row, events: JSON.parse(row.events) as unknown })), paging);
});

async function channelDestination(c: AppContext, input: Pick<z.output<typeof channelSchema>, 'kind' | 'destination'>) {
  try {
    validateDestination(input.kind, input.destination, c.env.OUTBOUND_HOSTS ?? '');
  } catch {
    abort(422, 'Use an approved HTTPS webhook or a valid email address');
  }
  if (input.kind === 'email' && (!c.env.EMAIL || !c.env.EMAIL_FROM)) abort(503, 'Email sending is not configured');
  const secret = c.env.ALERT_ENCRYPTION_KEY;
  if (!secret) throw new HTTPException(503, { message: 'Alert destination encryption is not configured' });
  return encryptDestination(secret, input.destination);
}

app.post('/api/channels', async (c) => {
  const input = await body(c, channelSchema);
  const encrypted = await channelDestination(c, input);
  const id = crypto.randomUUID();
  const inserted = await db(c).prepare(`
    INSERT INTO alert_channels(id,user_id,name,kind,encrypted_destination,events,cooldown_seconds,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM alert_channels WHERE user_id=?)<12 RETURNING id
  `).bind(id, owner(c), input.name, input.kind, encrypted, JSON.stringify([...new Set(input.events)]),
    input.cooldownSeconds, Date.now(), owner(c)).first();
  if (!inserted) abort(409, 'This account has reached the 12-channel limit');
  return json(c, { id }, 201);
});

app.patch('/api/channels/:id', async (c) => {
  const input = await body(c, channelFieldsSchema.omit({ kind: true }).partial());
  const row = await db(c).prepare(`SELECT ${channelFields} FROM alert_channels WHERE id=? AND user_id=?`)
    .bind(pathId(c), owner(c)).first<{ id: string; kind: 'email' | 'discord' | 'webhook' }>();
  if (!row) throw new HTTPException(404, { message: 'Alert channel not found' });
  const encrypted = input.destination ? await channelDestination(c, { kind: row.kind, destination: input.destination }) : null;
  await db(c).prepare(`
    UPDATE alert_channels SET name=COALESCE(?,name),encrypted_destination=COALESCE(?,encrypted_destination),
      events=COALESCE(?,events),cooldown_seconds=COALESCE(?,cooldown_seconds) WHERE id=? AND user_id=?
  `).bind(input.name ?? null, encrypted, input.events ? JSON.stringify([...new Set(input.events)]) : null,
    input.cooldownSeconds ?? null, row.id, owner(c)).run();
  return json(c, { id: row.id });
});

app.delete('/api/channels/:id', async (c) => {
  const deleted = await db(c).prepare('DELETE FROM alert_channels WHERE id=? AND user_id=? RETURNING id').bind(pathId(c), owner(c)).first();
  if (!deleted) abort(404, 'Alert channel not found');
  return json(c, deleted);
});

app.get('/api/deliveries', async (c) => {
  const paging = page(c);
  const rows = await db(c).prepare(`
    SELECT d.id,c.name AS channelName,m.name AS monitorName,d.event_kind AS eventKind,d.status,d.attempts,d.error,
      d.created_at AS createdAt,d.sent_at AS sentAt,d.next_at AS nextAt
    FROM alert_deliveries d JOIN alert_channels c ON c.id=d.channel_id JOIN monitors m ON m.id=d.monitor_id
    WHERE c.user_id=? ORDER BY d.created_at DESC,d.id LIMIT ? OFFSET ?
  `).bind(owner(c), paging.limit + 1, paging.offset).all();
  return list(c, rows.results, paging);
});

app.get('/api/status-pages', async (c) => {
  const paging = page(c);
  const rows = await db(c).prepare(`
    SELECT p.id,p.slug,p.title,p.description,
      (SELECT json_group_array(monitor_id) FROM (SELECT monitor_id FROM status_page_monitors
        WHERE page_id=p.id ORDER BY position)) AS monitorIds
    FROM status_pages p WHERE p.user_id=? ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?
  `).bind(owner(c), paging.limit + 1, paging.offset).all<{ monitorIds: string }>();
  return list(c, rows.results.map((row) => ({ ...row, monitorIds: JSON.parse(row.monitorIds) as unknown })), paging);
});

async function savePage(c: AppContext, input: z.output<typeof statusPageSchema>, update: boolean) {
  const id = update ? pathId(c) : crypto.randomUUID();
  const database = db(c);
  if (update && !await database.prepare('SELECT id FROM status_pages WHERE id=? AND user_id=?').bind(id, owner(c)).first()) {
    abort(404, 'Status page not found');
  }
  const monitorOwnership = await database.prepare(`SELECT COUNT(*) AS count FROM monitors WHERE user_id=?
    AND id IN (${input.monitorIds.map(() => '?').join(',')})`).bind(owner(c), ...input.monitorIds).first<number>('count');
  if (monitorOwnership !== input.monitorIds.length) abort(422, 'Select monitors owned by this account');
  const changes = update ? [
    database.prepare('UPDATE status_pages SET slug=?,title=?,description=? WHERE id=? AND user_id=?')
      .bind(input.slug, input.title, input.description, id, owner(c)),
    database.prepare('DELETE FROM status_page_monitors WHERE page_id=? AND EXISTS(SELECT 1 FROM status_pages WHERE id=? AND user_id=?)')
      .bind(id,id,owner(c)),
  ] : [
    database.prepare(`
      INSERT INTO status_pages(id,user_id,slug,title,description,created_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM status_pages WHERE user_id=?)<12
    `).bind(id, owner(c), input.slug, input.title, input.description, Date.now(), owner(c)),
  ];
  try {
    const outcomes = await database.batch([...changes, ...input.monitorIds.map((monitorId, index) => database.prepare(`
      INSERT INTO status_page_monitors(page_id,monitor_id,position)
      SELECT p.id,?,? FROM status_pages p WHERE p.id=? AND p.user_id=?
    `).bind(monitorId, index, id, owner(c)))]);
    if (!outcomes[0].meta.changes) abort(409, 'The status page could not be saved');
  } catch (error) {
    if (error instanceof Error && error.message.includes('status_pages.slug')) abort(409, 'This status page slug is already in use');
    throw error;
  }
  return json(c, { id, slug: input.slug }, update ? 200 : 201);
}

app.post('/api/status-pages', async (c) => savePage(c, await body(c, statusPageSchema), false));
app.patch('/api/status-pages/:id', async (c) => savePage(c, await body(c, statusPageSchema), true));
app.delete('/api/status-pages/:id', async (c) => {
  const deleted = await db(c).prepare('DELETE FROM status_pages WHERE id=? AND user_id=? RETURNING id').bind(pathId(c), owner(c)).first();
  if (!deleted) abort(404, 'Status page not found');
  return json(c, deleted);
});

app.notFound((c) => c.json({ error: { message: 'Route not found' } }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: { message: error.message } }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: { message: 'Invalid query parameters' } }, 422);
  console.error(JSON.stringify({ event: 'request_error', method: c.req.method, errorType: error.name }));
  return c.json({ error: { message: 'An unexpected error occurred' } }, 500);
});

export default {
  fetch: app.fetch,
  queue: (batch, env) => consume(batch, env),
  async scheduled(controller, env) {
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName('cron'));
    const result = await scheduler.fetch(`https://scheduler.internal/tick?time=${controller.scheduledTime}`);
    if (!result.ok) throw new Error('Cron scheduling failed');
  },
} satisfies ExportedHandler<Env, Job>;
