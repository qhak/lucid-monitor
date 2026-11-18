CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user ON session(user_id);
CREATE TABLE account (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(provider_id, account_id)
);
CREATE INDEX account_user ON account(user_id);
CREATE TABLE verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX verification_identifier ON verification(identifier);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(state IN ('operational','degraded','down','paused','unknown')),
  interval_seconds INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('GET','HEAD')),
  expected_status INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, expected_content TEXT,
  failure_threshold INTEGER NOT NULL, recovery_threshold INTEGER NOT NULL,
  slow_ms INTEGER NOT NULL, alerts_enabled INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, next_due INTEGER NOT NULL,
  failure_streak INTEGER NOT NULL DEFAULT 0, success_streak INTEGER NOT NULL DEFAULT 0,
  last_slot INTEGER, last_checked_at INTEGER, last_success INTEGER, last_failure INTEGER,
  certificate_expires_at INTEGER, domain_expires_at INTEGER, metadata_due INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX monitors_owner ON monitors(user_id, created_at DESC, id);
CREATE INDEX monitors_due ON monitors(next_due) WHERE state <> 'paused';

CREATE TABLE checks (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','ok','failed','missed')),
  dispatch_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, claim TEXT,
  checked_at INTEGER, latency_ms INTEGER, http_status INTEGER, error TEXT,
  PRIMARY KEY(monitor_id, generation, scheduled_at)
);
CREATE INDEX checks_monitor_time ON checks(monitor_id, scheduled_at DESC);
CREATE INDEX checks_pending ON checks(dispatch_at) WHERE status='pending';
CREATE INDEX checks_running ON checks(lease_until) WHERE status='running';
CREATE INDEX checks_retention ON checks(scheduled_at);
CREATE TABLE aggregates (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL, missing INTEGER NOT NULL,
  latency_count INTEGER NOT NULL, latency_sum INTEGER NOT NULL,
  PRIMARY KEY(monitor_id, hour)
);
CREATE INDEX aggregate_retention ON aggregates(hour);
CREATE TABLE latency_histogram (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL, bucket INTEGER NOT NULL, samples INTEGER NOT NULL,
  PRIMARY KEY(monitor_id, hour, bucket)
);
CREATE INDEX histogram_retention ON latency_histogram(hour);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  title TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('automatic','manual')),
  opened_at INTEGER NOT NULL, acknowledged_at INTEGER, resolved_at INTEGER
);
CREATE UNIQUE INDEX incidents_active ON incidents(monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_history ON incidents(monitor_id, opened_at DESC);
CREATE TABLE incident_events (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('opened','acknowledged','resolved','note')),
  message TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX incident_events_timeline ON incident_events(incident_id, created_at);

CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('email','discord','webhook')),
  encrypted_destination TEXT NOT NULL, events TEXT NOT NULL CHECK(json_valid(events)),
  cooldown_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX alert_channels_owner ON alert_channels(user_id);
CREATE TABLE alert_deliveries (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES incident_events(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0, error TEXT, sent_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(channel_id, event_id)
);
CREATE INDEX alert_deliveries_pending ON alert_deliveries(next_at) WHERE status='pending';
CREATE INDEX alert_deliveries_sending ON alert_deliveries(lease_until) WHERE status='sending';
CREATE INDEX alert_deliveries_channel ON alert_deliveries(channel_id, monitor_id, event_kind, sent_at);
CREATE INDEX alert_deliveries_retention ON alert_deliveries(created_at);

CREATE TABLE status_pages (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX status_pages_owner ON status_pages(user_id);
CREATE TABLE status_page_monitors (
  page_id TEXT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, PRIMARY KEY(page_id, monitor_id)
);
CREATE INDEX status_page_monitors_monitor ON status_page_monitors(monitor_id);

CREATE TRIGGER incident_opened AFTER INSERT ON incidents
BEGIN
  INSERT INTO incident_events(id,incident_id,kind,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.id,'opened',NEW.opened_at);
END;
CREATE TRIGGER incident_acknowledged AFTER UPDATE OF acknowledged_at ON incidents
WHEN OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL
BEGIN
  INSERT INTO incident_events(id,incident_id,kind,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.id,'acknowledged',NEW.acknowledged_at);
END;
CREATE TRIGGER incident_resolved AFTER UPDATE OF resolved_at ON incidents
WHEN OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL
BEGIN
  INSERT INTO incident_events(id,incident_id,kind,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.id,'resolved',NEW.resolved_at);
END;
CREATE TRIGGER incident_alert AFTER INSERT ON incident_events WHEN NEW.kind <> 'note'
BEGIN
  INSERT OR IGNORE INTO alert_deliveries
    (id,channel_id,monitor_id,event_id,event_kind,payload,next_at,created_at)
  SELECT lower(hex(randomblob(16))),c.id,m.id,NEW.id,NEW.kind,
    json_object('incidentId',i.id,'monitorId',m.id,'monitorName',m.name,
      'title',i.title,'kind',NEW.kind,'createdAt',NEW.created_at),
    NEW.created_at,NEW.created_at
  FROM incidents i JOIN monitors m ON m.id=i.monitor_id
  JOIN alert_channels c ON c.user_id=m.user_id
  WHERE i.id=NEW.incident_id AND m.alerts_enabled=1
    AND EXISTS (SELECT 1 FROM json_each(c.events) WHERE value=NEW.kind);
END;

CREATE TRIGGER monitor_status AFTER UPDATE OF state ON monitors
WHEN NEW.state <> OLD.state
BEGIN
  INSERT OR IGNORE INTO incidents(id,monitor_id,title,source,opened_at)
    SELECT lower(hex(randomblob(16))),NEW.id,'Availability check failed','automatic',NEW.last_checked_at
    WHERE NEW.state='down';
  UPDATE incidents SET resolved_at=MAX(opened_at,NEW.last_checked_at)
    WHERE monitor_id=NEW.id AND resolved_at IS NULL AND source='automatic' AND NEW.state='operational';
END;

CREATE TRIGGER check_scheduled AFTER INSERT ON checks
BEGIN
  UPDATE monitors SET next_due=next_due+interval_seconds*1000
    WHERE id=NEW.monitor_id AND generation=NEW.generation AND next_due=NEW.scheduled_at;
END;

CREATE TRIGGER check_final AFTER UPDATE OF status ON checks
WHEN OLD.status IN ('pending','running') AND NEW.status IN ('ok','failed','missed')
BEGIN
  INSERT INTO aggregates(monitor_id,hour,passed,failed,missing,latency_count,latency_sum)
    VALUES(NEW.monitor_id,NEW.scheduled_at/3600000*3600000,NEW.status='ok',
      NEW.status='failed',NEW.status='missed',NEW.latency_ms IS NOT NULL,COALESCE(NEW.latency_ms,0))
    ON CONFLICT(monitor_id,hour) DO UPDATE SET passed=passed+excluded.passed,
      failed=failed+excluded.failed, missing=missing+excluded.missing,
      latency_count=latency_count+excluded.latency_count,latency_sum=latency_sum+excluded.latency_sum;
  INSERT INTO latency_histogram(monitor_id,hour,bucket,samples)
    SELECT NEW.monitor_id,NEW.scheduled_at/3600000*3600000,
      (NEW.latency_ms+5)/10*10,1 WHERE NEW.latency_ms IS NOT NULL
    ON CONFLICT(monitor_id,hour,bucket) DO UPDATE SET samples=samples+1;
  UPDATE monitors SET
    last_slot=NEW.scheduled_at,
    last_checked_at=CASE WHEN NEW.status='missed' THEN last_checked_at ELSE NEW.checked_at END,
    last_success=CASE WHEN NEW.status='ok' THEN NEW.checked_at ELSE last_success END,
    last_failure=CASE WHEN NEW.status='failed' THEN NEW.checked_at ELSE last_failure END,
    failure_streak=CASE WHEN NEW.status='failed' THEN failure_streak+1 ELSE 0 END,
    success_streak=CASE WHEN NEW.status='ok' AND NEW.latency_ms<=slow_ms THEN success_streak+1 ELSE 0 END,
    state=CASE
      WHEN NEW.status='missed' THEN CASE WHEN state='down' THEN 'down' ELSE 'unknown' END
      WHEN NEW.status='failed' AND failure_streak+1>=failure_threshold THEN 'down'
      WHEN NEW.status='failed' AND state='down' THEN 'down'
      WHEN NEW.status='failed' THEN 'degraded'
      WHEN NEW.latency_ms>slow_ms AND state='down' THEN 'down'
      WHEN NEW.latency_ms>slow_ms THEN 'degraded'
      WHEN success_streak+1>=recovery_threshold THEN 'operational'
      WHEN state IN ('unknown','down') THEN state
      ELSE 'degraded'
    END
    WHERE id=NEW.monitor_id AND generation=NEW.generation AND state<>'paused'
      AND (last_slot IS NULL OR last_slot<NEW.scheduled_at);
END;
