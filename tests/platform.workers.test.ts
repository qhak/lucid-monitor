/// <reference types="@cloudflare/vitest-plugin/types" />
import { env as bindings } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../server/index';
import { type CheckJob, type Env, roundMinute } from '../server/model';
import { executeCheck } from '../server/pipeline';

const env = bindings as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const origin = 'https://lucid.test';
const invite = 'local-test-invitation';

async function request(path: string, method = 'GET', payload?: object, cookie?: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  if (cookie) requestHeaders.set('cookie', cookie);
  if (payload) requestHeaders.set('content-type', 'application/json');
  return worker.fetch(new Request(origin + '/api' + path, {
    method, headers: requestHeaders, body: payload ? JSON.stringify(payload) : undefined,
  }), env, createExecutionContext());
}

async function signup(name: string) {
  const response = await request('/auth/sign-up/email', 'POST', {
    name, email: name.toLowerCase() + '@example.com', password: 'example-test-password-24',
  }, undefined, { origin, 'x-registration-key': invite });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Test signup failed (${response.status}): ${await response.text()}`);
  return cookie;
}

async function createMonitor(cookie: string, overrides: object = {}) {
  const result = await request('/monitors', 'POST', {
    name: 'Example', url: 'https://example.com/health?private=marker', ...overrides,
  }, cookie);
  const payload = await result.json<{ data?: { id: string }; error?: { message: string } }>();
  if (!payload.data || result.status !== 201) throw new Error(`Test monitor creation failed: ${payload.error?.message}`);
  return payload.data.id;
}

describe('Worker API and D1', () => {
  it('requires an invite, isolates accounts, preserves partial edits and publishes an allowlisted view', async () => {
    expect((await request('/monitors')).status).toBe(401);
    expect((await request('/auth/sign-up/email', 'POST', { name: 'Forbidden' })).status).toBe(403);
    const cookie = await signup('Atlas');
    const other = await signup('Second');
    const id = await createMonitor(cookie, { method: 'HEAD', intervalSeconds: 180, failureThreshold: 4, alertsEnabled: false });
    expect((await request('/monitors/' + id)).status).toBe(401);
    expect((await request('/monitors/' + id, 'GET', undefined, other)).status).toBe(404);
    expect((await request('/monitors/' + id, 'DELETE', undefined, other)).status).toBe(404);
    expect((await request('/monitors/' + id, 'PATCH', { name: 'API health' }, cookie)).status).toBe(200);
    const detail = await request('/monitors/' + id + '/status', 'GET', undefined, cookie);
    expect(await detail.json()).toMatchObject({ data: {
      name: 'API health', method: 'HEAD', intervalSeconds: 180, failureThreshold: 4, alertsEnabled: false,
    } });
    expect((await request('/monitors/' + id, 'PATCH', { name: 'Invalid origin' }, cookie, { origin: 'https://outside.test' })).status).toBe(403);
    const page = { slug: 'atlas', title: 'Atlas status', monitorIds: [id] };
    expect((await request('/status-pages', 'POST', page, other)).status).toBe(422);
    expect((await request('/status-pages', 'POST', page, cookie)).status).toBe(201);
    expect((await request('/incidents', 'POST', { monitorId: id, title: 'Private details' }, cookie)).status).toBe(201);
    const publicResponse = await request('/public/atlas');
    expect(publicResponse.status).toBe(200);
    const publicText = await publicResponse.text();
    expect(JSON.parse(publicText)).toMatchObject({ data: { state: 'degraded' } });
    expect(publicText).toContain('API health');
    expect(publicText).toContain('Availability incident');
    for (const privateValue of ['private=marker', 'expectedStatus', 'Private details', 'alertsEnabled']) {
      expect(publicText).not.toContain(privateValue);
    }
    expect((await request('/monitors/' + id + '/pause', 'POST', undefined, cookie)).status).toBe(200);
    expect((await request('/monitors/' + id + '/resume', 'POST', undefined, cookie)).status).toBe(200);
    expect((await request('/monitors/' + id, 'DELETE', undefined, cookie)).status).toBe(200);
  });

  it('applies concurrent and repeated deliveries once, honors thresholds and calculates coverage', async () => {
    const cookie = await signup('Runtime');
    const id = await createMonitor(cookie, { failureThreshold: 2, recoveryThreshold: 2 });
    const channel = await request('/channels', 'POST', {
      name: 'Lifecycle webhook', kind: 'webhook', destination: 'https://example.com/lifecycle',
      events: ['opened', 'acknowledged', 'resolved'],
    }, cookie);
    expect(channel.status).toBe(201);
    const first = roundMinute(Date.now());
    // Skip optional metadata calls in this deterministic pipeline fixture.
    await env.DB.prepare('UPDATE monitors SET metadata_due=? WHERE id=?').bind(Date.now() + 3600000, id).run();
    const failed = vi.fn(async () => ({ ok: false, latencyMs: 13, httpStatus: 503, error: 'Unexpected status' }));
    const succeeded = vi.fn(async () => ({ ok: true, latencyMs: 47, httpStatus: 200, error: null }));
    const work = async (scheduledAt: number, probe: NonNullable<Parameters<typeof executeCheck>[2]>) => {
      const job: CheckJob = { type: 'check', monitorId: id, generation: 1, scheduledAt };
      await env.DB.prepare("INSERT INTO checks(monitor_id,generation,scheduled_at,status,dispatch_at) VALUES(?,1,?,'pending',0)")
        .bind(id, scheduledAt).run();
      await Promise.all([executeCheck(env, job, probe), executeCheck(env, job, probe)]);
      await executeCheck(env, job, probe);
    };
    await work(first, failed);
    let result = await request('/monitors/' + id + '/status', 'GET', undefined, cookie);
    expect(await result.json()).toMatchObject({ data: { state: 'degraded', activeIncident: false } });

    await work(first + 1000, failed);
    const incident = await env.DB.prepare('SELECT id FROM incidents WHERE monitor_id=?').bind(id).first<{ id: string }>();
    expect(incident).not.toBeNull();
    expect(failed).toHaveBeenCalledTimes(2);
    expect((await request('/incidents/' + incident!.id + '/acknowledge', 'POST', undefined, cookie)).status).toBe(200);
    expect((await request('/incidents/' + incident!.id + '/acknowledge', 'POST', undefined, cookie)).status).toBe(200);
    expect((await request('/incidents/' + incident!.id + '/annotate', 'POST', { message: 'Read-only issue' }, cookie)).status).toBe(201);

    await work(first + 2000, succeeded);
    result = await request('/monitors/' + id + '/status', 'GET', undefined, cookie);
    expect(await result.json()).toMatchObject({ data: { state: 'down', activeIncident: true } });
    await work(first + 3000, succeeded);

    result = await request('/monitors/' + id, 'GET', undefined, cookie);
    expect(await result.json()).toMatchObject({ data: {
      monitor: { state: 'operational', activeIncident: false },
      metrics: { checked: 4, uptime: 50, avgLatency: 30, p50: 10, p95: 50, p99: 50, incidentFrequency: 1 },
      incidents: [{ id: incident!.id, events: expect.arrayContaining([
        expect.objectContaining({ kind: 'opened' }), expect.objectContaining({ kind: 'acknowledged' }),
        expect.objectContaining({ kind: 'resolved' }), expect.objectContaining({ kind: 'note' }),
      ]) }],
    } });
    expect(succeeded).toHaveBeenCalledTimes(2);
    const deliveries = await env.DB.prepare('SELECT event_kind FROM alert_deliveries WHERE monitor_id=? ORDER BY event_kind').bind(id).all();
    expect(deliveries.results).toEqual([{ event_kind: 'acknowledged' }, { event_kind: 'opened' }, { event_kind: 'resolved' }]);

    expect((await request('/status-pages', 'POST', { slug: 'runtime', title: 'Runtime status', monitorIds: [id] }, cookie)).status).toBe(201);
    const published = await request('/public/runtime');
    expect(await published.json()).toMatchObject({ data: {
      monitors: [{ id, uptime: 50, series: expect.arrayContaining([{ time: expect.any(Number), passed: 2, failed: 2, missing: 0 }]) }],
    } });
  });

  it('reserves slots through the scheduler and acknowledges stale queue jobs', async () => {
    const cookie = await signup('Scheduler');
    const id = await createMonitor(cookie);
    const delayed = await createMonitor(cookie, { name: 'Delayed schedule' });
    const minute = roundMinute(Date.now());
    await env.DB.prepare('UPDATE monitors SET next_due=? WHERE id=?').bind(minute - 180000, id).run();
    await env.DB.prepare('UPDATE monitors SET next_due=? WHERE id=?').bind(minute - 180 * 60000, delayed).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: minute }), env);
    const slots = await env.DB.prepare('SELECT status FROM checks WHERE monitor_id=? ORDER BY scheduled_at').bind(id).all<{ status: string }>();
    expect(slots.results).toHaveLength(4);
    expect(slots.results[0].status).toBe('missed');
    const fresh = await env.DB.prepare('SELECT scheduled_at AS scheduledAt FROM checks WHERE monitor_id=?')
      .bind(delayed).all();
    expect(fresh.results).toEqual([{ scheduledAt: minute }]);
    const missedGap = await env.DB.prepare('SELECT SUM(missing) AS missed FROM aggregates WHERE monitor_id=?')
      .bind(delayed).first<number>('missed');
    expect(missedGap).toBe(180);
    const stale = createMessageBatch('lucid-checks-test', [{
      id: 'old', timestamp: minute, attempts: 1,
      body: { type: 'check', monitorId: id, generation: 1, scheduledAt: minute - 180000 } satisfies CheckJob,
    }]);
    await worker.queue(stale, env);
    const outcome = await getQueueResult(stale, ctx);
    expect(outcome.explicitAcks).toContain('old');
    const metrics = await request('/monitors/' + id + '/metrics', 'GET', undefined, cookie);
    expect(await metrics.json()).toMatchObject({ data: { checked: 0, uptime: null, missed: expect.any(Number) } });
  });
});
