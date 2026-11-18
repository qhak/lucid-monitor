import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { encryptDestination, processAlert, validateDestination } from '../server/alerts';

const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
const recipient = 'oncall@example.com';

function stubProvider(send: (url: URL, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'cloudflare-dns.com') {
      const answers = url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [];
      return Response.json({ Status: 0, TC: false, Answer: answers });
    }
    return send(url, init);
  });
}

describe('alert destinations', () => {
  it('uses fresh authenticated encryption for every destination', async () => {
    const first = await encryptDestination(secret, recipient);
    const second = await encryptDestination(secret, recipient);
    expect(first).not.toContain(recipient);
    expect(first).not.toBe(second);
    await expect(encryptDestination(btoa('wrong length'), recipient)).rejects.toThrow();
  });

  it('requires a single email address', () => {
    expect(() => validateDestination('email', 'oncall+alerts@example.com', '')).not.toThrow();
    expect(() => validateDestination('email', 'oncall@example.com\r\nBcc:secret@example.com', '')).toThrow();
  });

  it('restricts Discord destinations to the official webhook endpoint', () => {
    const path = '/api/webhooks/123456789012345678/standard_webhook-token';
    expect(() => validateDestination('discord', `https://discord.com${path}`, '')).not.toThrow();
    expect(() => validateDestination('discord', `https://discord.com.example${path}`, '')).toThrow();
    expect(() => validateDestination('discord', `https://discord.com/channels/123`, '')).toThrow();
    expect(() => validateDestination('discord', `https://discord.com${path}?thread_id=1`, '')).toThrow();
  });

  it('permits only HTTPS delivery to approved webhook hosts', () => {
    const hosts = 'other.example,hooks.example';
    expect(() => validateDestination('webhook', 'https://hooks.example/receive?key=a', hosts)).not.toThrow();
    expect(() => validateDestination('webhook', 'http://hooks.example/receive', hosts)).toThrow();
    expect(() => validateDestination('webhook', 'https://user@hooks.example/receive', hosts)).toThrow();
    expect(() => validateDestination('webhook', 'https://other.hooks.example/receive', hosts)).toThrow();
    expect(() => validateDestination('webhook', 'https://hooks.example:444/receive', hosts)).toThrow();
  });
});

async function setup(send: (message: { from: string; to: string; subject: string; text: string }) => Promise<unknown>) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));

  const DB = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() { return statement.run(...values); },
          };
        },
      };
    },
  } as unknown as D1Database;

  const now = Date.now();
  const destination = await encryptDestination(secret, recipient);
  database.prepare(`INSERT INTO alert_channels
    (id, user_id, name, kind, encrypted_destination, events, cooldown_seconds, created_at)
    VALUES ('channel', 'user', 'On-call', 'email', ?, '["opened","resolved"]', 60, ?)`).run(destination, now);

  function add(id: string, kind = 'opened') {
    const payload = JSON.stringify({ incidentId: 'incident', monitorId: 'monitor', monitorName: 'Checkout', title: 'Checkout is down', kind, createdAt: now });
    database.prepare(`INSERT INTO alert_deliveries
      (id, channel_id, monitor_id, event_id, event_kind, payload, status, attempts, next_at, created_at)
      VALUES (?, 'channel', 'monitor', ?, ?, ?, 'pending', 0, ?, ?)`).run(id, id, kind, payload, now, now);
  }

  function get(id: string) {
    return database.prepare('SELECT * FROM alert_deliveries WHERE id = ?').get(id);
  }

  const env = { DB, ALERT_ENCRYPTION_KEY: secret, EMAIL: { send }, EMAIL_FROM: 'alerts@example.com' };
  return { database, env, add, get };
}

describe('alert delivery', () => {
  it('claims a single delivery under concurrent or repeated queue processing', async () => {
    const messages: unknown[] = [];
    const { database, env, add, get } = await setup(async (message) => messages.push(message));
    try {
      add('first');
      await Promise.all([processAlert(env, 'first'), processAlert(env, 'first')]);
      await processAlert(env, 'first');
      expect(messages).toMatchObject([{ from: 'alerts@example.com', to: recipient, subject: expect.stringContaining('Checkout') }]);
      expect(get('first')).toMatchObject({ status: 'sent', attempts: 1 });
    } finally {
      database.close();
    }
  });

  it('applies cooldown to repeat events while preserving recovery notifications', async () => {
    const { database, env, add, get } = await setup(async () => undefined);
    try {
      add('first');
      add('repeat');
      add('recovery', 'resolved');
      await processAlert(env, 'first');
      await processAlert(env, 'repeat');
      await processAlert(env, 'recovery');
      expect(get('repeat')).toMatchObject({ status: 'suppressed', attempts: 0 });
      expect(get('recovery')).toMatchObject({ status: 'sent', attempts: 1 });
    } finally {
      database.close();
    }
  });

  it('defers retryable failures and redacts provider errors', async () => {
    let calls = 0;
    const { database, env, add, get } = await setup(async () => {
      if (calls++ === 0) throw new Error(`Could not reach ${recipient} with a private token`);
    });
    try {
      add('first');
      await processAlert(env, 'first');
      const failed = get('first');
      expect(failed).toMatchObject({ status: 'pending', attempts: 1, error: expect.any(String) });
      expect(Number(failed?.next_at)).toBeGreaterThan(Date.now());
      expect(failed?.error).not.toContain(recipient);
      await processAlert(env, 'first');
      expect(calls).toBe(1);
      database.prepare('UPDATE alert_deliveries SET next_at = 0 WHERE id = ?').run('first');
      await processAlert(env, 'first');
      expect(get('first')).toMatchObject({ status: 'sent', attempts: 2, error: null });
    } finally {
      database.close();
    }
  });

  it('recovers an expired sending lease and rejects tampered ciphertext', async () => {
    let calls = 0;
    const { database, env, add, get } = await setup(async () => { calls++; });
    try {
      add('expired');
      database.prepare("UPDATE alert_deliveries SET status = 'sending', attempts = 1, lease_until = 1 WHERE id = ?").run('expired');
      await processAlert(env, 'expired');
      expect(get('expired')).toMatchObject({ status: 'sent', attempts: 2 });

      const encrypted = database.prepare('SELECT encrypted_destination FROM alert_channels').get()?.encrypted_destination as string;
      const offset = encrypted.lastIndexOf('.') + 1;
      const tampered = `${encrypted.slice(0, offset)}${encrypted[offset] === 'A' ? 'B' : 'A'}${encrypted.slice(offset + 1)}`;
      database.prepare('UPDATE alert_channels SET encrypted_destination = ?').run(tampered);
      add('tampered', 'resolved');
      await processAlert(env, 'tampered');
      expect(get('tampered')).toMatchObject({ status: 'failed' });
      expect(calls).toBe(1);
    } finally {
      database.close();
    }
  });

  it('serializes concurrent events with the same cooldown key', async () => {
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { release = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const { database, env, add, get } = await setup(async () => {
      notifyStarted();
      await sending;
    });
    try {
      add('first');
      add('repeat');
      const first = processAlert(env, 'first');
      await started;
      await processAlert(env, 'repeat');
      expect(get('repeat')).toMatchObject({ status: 'pending', attempts: 0 });
      release();
      await first;
      await processAlert(env, 'repeat');
      expect(get('repeat')).toMatchObject({ status: 'suppressed', attempts: 0 });
    } finally {
      release();
      database.close();
    }
  });

  it('records an invalid payload as a permanent redacted failure', async () => {
    let calls = 0;
    const { database, env, add, get } = await setup(async () => { calls++; });
    try {
      add('invalid');
      database.prepare("UPDATE alert_deliveries SET payload = 'null' WHERE id = ?").run('invalid');
      await processAlert(env, 'invalid');
      expect(get('invalid')).toMatchObject({ status: 'failed', attempts: 1 });
      expect(calls).toBe(0);
    } finally {
      database.close();
    }
  });

  it('posts a webhook with a stable idempotency key and never follows redirects', async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const { database, env, add, get } = await setup(async () => undefined);
    stubProvider((url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return new Response(null, { status: 503 });
      return Response.redirect('https://outside.example/');
    });
    try {
      const destination = await encryptDestination(secret, 'https://hooks.example/receive?key=secret');
      database.prepare("UPDATE alert_channels SET kind = 'webhook', encrypted_destination = ?").run(destination);
      add('webhook');
      const webhookEnv = { ...env, OUTBOUND_HOSTS: 'hooks.example' };
      await processAlert(webhookEnv, 'webhook');
      expect(get('webhook')).toMatchObject({ status: 'pending', attempts: 1 });
      database.prepare('UPDATE alert_deliveries SET next_at = 0 WHERE id = ?').run('webhook');
      await processAlert(webhookEnv, 'webhook');
      expect(get('webhook')).toMatchObject({ status: 'failed', attempts: 2 });
      expect(get('webhook')?.error).not.toContain('secret');
      expect(requests).toHaveLength(2);
      for (const { url, init } of requests) {
        expect(url.hostname).toBe('hooks.example');
        expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('webhook');
        expect(JSON.parse(init?.body as string)).toMatchObject({ monitorName: 'Checkout', kind: 'opened' });
      }
    } finally {
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it('requests Discord confirmation and suppresses user-controlled mentions', async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const { database, env, add, get } = await setup(async () => undefined);
    stubProvider((url, init) => {
      requests.push({ url, init });
      return Response.json({ id: 'mock-message' });
    });
    try {
      const destination = await encryptDestination(secret, 'https://discord.com/api/webhooks/123456789012345678/webhook-secret');
      database.prepare("UPDATE alert_channels SET kind = 'discord', encrypted_destination = ?").run(destination);
      add('discord', 'resolved');
      await processAlert(env, 'discord');
      expect(get('discord')).toMatchObject({ status: 'sent', attempts: 1 });
      expect(requests).toHaveLength(1);
      expect(requests[0].url.searchParams.get('wait')).toBe('true');
      expect(JSON.parse(requests[0].init?.body as string)).toMatchObject({
        content: expect.stringContaining('Checkout (resolved)'), allowed_mentions: { parse: [] },
      });
    } finally {
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it('stops retrying at the delivery attempt limit', async () => {
    let calls = 0;
    const { database, env, add, get } = await setup(async () => {
      calls++;
      throw new Error('temporary');
    });
    try {
      add('retry');
      for (let attempt = 0; attempt < 6; attempt++) {
        database.prepare('UPDATE alert_deliveries SET next_at = 0 WHERE id = ?').run('retry');
        await processAlert(env, 'retry');
      }
      expect(get('retry')).toMatchObject({ status: 'failed', attempts: 5 });
      expect(calls).toBe(5);
    } finally {
      database.close();
    }
  });
});
