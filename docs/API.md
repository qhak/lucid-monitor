# Lucid Monitor REST API

The Worker serves the API on the same origin as the dashboard. Private endpoints use a Better Auth session cookie. Authentication endpoints use Better Auth's native response format. All other successes return `{"data":…}` and application errors return `{"error":{"message":"…"}}`. Time fields use UTC epoch milliseconds. Duration fields ending in `Seconds` and `Ms` identify their units.

```bash
BASE=http://localhost:8787
curl -fsS -c lucid.cookies "$BASE/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  --data '{"email":"operator@example.com","password":"your-local-password"}'

curl -fsS -b lucid.cookies "$BASE/api/monitors" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Example website","url":"https://example.com/","intervalSeconds":60,"failureThreshold":3,"recoveryThreshold":2}'

# Set ID to the identifier returned by monitor creation.
curl -fsS -b lucid.cookies "$BASE/api/monitors/$ID/metrics?period=7d"
curl -fsS -b lucid.cookies -X POST "$BASE/api/monitors/$ID/pause"
curl -fsS -b lucid.cookies -X POST "$BASE/api/monitors/$ID/resume"
```

Create an account through the UI or POST to `/api/auth/sign-up/email` with `name`, `email`, and `password`, plus the `X-Registration-Key` invite header. Sign out with POST `/api/auth/sign-out` and remove the cookie jar when finished. Use HTTPS on remote instances.

Lists accept `limit` (1 to 100) and `offset` (0 to 10000), and return the next offset in `X-Next-Offset` when more records exist. Metrics and history accept `period=24h|7d|30d|90d`, with `24h` as the default.

| Method | Path under `/api` | Purpose |
| --- | --- | --- |
| GET | `/overview` | Owner's monitor counts and weighted 24-hour stats and series |
| GET, POST | `/monitors` | List or create monitors |
| GET, PATCH, DELETE | `/monitors/:id` | Detail with metrics, recent checks, and incidents; partial edit; removal |
| POST | `/monitors/:id/pause`, `/monitors/:id/resume` | Pause or resume scheduling |
| GET | `/monitors/:id/status` | Current monitor state and configuration |
| GET | `/monitors/:id/history` | UTC buckets with passing, failing, and missing counts |
| GET | `/monitors/:id/metrics` | Uptime, latency percentiles, incident count, downtime, and MTTR |
| GET, POST | `/incidents` | Incident timeline list or create a manual incident |
| POST | `/incidents/:id/acknowledge`, `/incidents/:id/resolve` | Acknowledge or close an incident |
| POST | `/incidents/:id/annotate` | Add a private note with `{"message":"…"}` |
| GET, POST | `/channels` | List or create alert channels |
| PATCH, DELETE | `/channels/:id` | Edit channel settings or delete an alert channel |
| GET | `/deliveries` | Alert status, attempt count, next attempt, and safe error information |
| GET, POST | `/status-pages` | List or create public pages |
| PATCH, DELETE | `/status-pages/:id` | Replace page configuration or delete a page |
| GET | `/public/:slug` | Public status page data without a session |

### Request fields

- Monitors require `name` and `url`. Optional fields are `intervalSeconds` (60 to 86400 in whole minutes), `method` (GET or HEAD), `expectedStatus` (100 to 599), `timeoutMs` (500 to 20000), `expectedContent` (nullable substring for GET), `failureThreshold` and `recoveryThreshold` (1 to 10), `slowMs` (100 to 20000), and `alertsEnabled` (Boolean). Pause and resume take an empty body.
- Manual incidents take `monitorId` and `title`. There is one active incident per monitor.
- Alert channels take `name`, `kind` (email, discord, or webhook), and `destination`. Configure `events` using any of `opened`, `acknowledged`, and `resolved`, and set `cooldownSeconds` between 0 and 86400. Defaults are opened and resolved with a 300-second cooldown per channel, monitor, and event kind. Destination is write-only. Channel kind is fixed on creation.
- Public pages take `slug` (lowercase words and numbers separated by hyphens), `title`, optional `description`, and `monitorIds` (1 to 20 owned monitors in display order). Share `/status/:slug` for the human-readable view.

Validation errors use 422, missing sessions use 401, and ownership lookups return 404 for unavailable resources. Conflicting slugs, an already active incident, and account quotas use 409. Rate limiting uses 429.
