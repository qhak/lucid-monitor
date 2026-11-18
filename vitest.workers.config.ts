import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    main: './server/index.ts',
    miniflare: {
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      d1Databases: ['DB'],
      durableObjects: { SCHEDULER: { className: 'Scheduler', useSQLite: true } },
      queueProducers: { CHECK_QUEUE: 'lucid-checks-test', ALERT_QUEUE: 'lucid-alerts-test' },
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        AUTH_URL: 'https://lucid.test',
        AUTH_SECRET: 'lucid-monitor-test-fixture-secret-not-for-deployment',
        REGISTRATION_KEY: 'local-test-invitation',
        OUTBOUND_HOSTS: 'example.com',
        ALERT_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    },
  }))],
  test: { include: ['tests/**/*.workers.test.ts'] },
});
