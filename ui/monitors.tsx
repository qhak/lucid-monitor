import { useMemo, useState, type FormEvent } from 'react'
import { Activity, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, ChevronRight, CircleAlert, Clock3, Globe, Pause, Pencil, Play, Plus, Radio, Search, Timer, Trash2, TrendingUp, Zap } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Empty, ExternalLink, Feedback, Field, Header, Load, Modal, Stat, Strip, Trend } from './components'
import { dateTime, duration, errorText, expiryDate, formText, latency, percent, request, stateLabels, useData, type DetailData, type Monitor, type OverviewData } from './data'

const numericFields = [
  ['intervalSeconds', 'Check interval (seconds)', 60, 86400, 60, 60],
  ['timeoutMs', 'Timeout (milliseconds)', 500, 20000, 10000, 1],
  ['expectedStatus', 'Expected HTTP status', 100, 599, 200, 1],
  ['slowMs', 'Slow threshold (milliseconds)', 100, 20000, 2000, 1],
  ['failureThreshold', 'Failures to open an incident', 1, 10, 3, 1],
  ['recoveryThreshold', 'Successes to resolve an incident', 1, 10, 2, 1],
] as const

export function MonitorForm({ monitor, close, save }: { monitor?: Monitor; close: () => void; save: () => void }) {
  const [method, setMethod] = useState(monitor?.method ?? 'GET')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await request(monitor ? `/monitors/${monitor.id}` : '/monitors', {
        method: monitor ? 'PATCH' : 'POST',
        body: {
          name: formText(form, 'name').trim(), url: formText(form, 'url').trim(), method,
          ...Object.fromEntries(numericFields.map(([name]) => [name, Number(formText(form, name))])),
          expectedContent: method === 'GET' ? formText(form, 'expectedContent') || null : null,
          alertsEnabled: form.has('alertsEnabled'),
        },
      })
      save()
      close()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={monitor ? 'Edit monitor' : 'Add monitor'} description="Configure an HTTP check for an endpoint." close={close} busy={busy}>
    <form onSubmit={submit}>
      <div className="fields">
        <Field label="Name" wide><input name="name" required maxLength={100} placeholder="Public API" defaultValue={monitor?.name} /></Field>
        <Field label="Endpoint URL" wide><input name="url" type="url" required maxLength={2048} placeholder="https://example.com/health" defaultValue={monitor?.url} /></Field>
        {numericFields.map(([name, label, min, max, initial, step]) => <Field key={name} label={label}>
          <input name={name} type="number" min={min} max={max} step={step} required defaultValue={monitor?.[name] ?? initial} />
        </Field>)}
        <Field label="HTTP method"><select value={method} onChange={event => setMethod(event.target.value === 'HEAD' ? 'HEAD' : 'GET')}>
          {['GET', 'HEAD'].map(option => <option key={option}>{option}</option>)}
        </select></Field>
        <label className="check-label self-end"><input type="checkbox" name="alertsEnabled" defaultChecked={monitor?.alertsEnabled ?? true} /> Send incident alerts</label>
        <Field label="Expected response text" help={method === 'HEAD' ? 'Available with GET checks.' : undefined} wide><input name="expectedContent" maxLength={1024} placeholder="Optional" defaultValue={monitor?.expectedContent ?? ''} disabled={method === 'HEAD'} /></Field>
      </div>
      <Feedback error={error} />
      <div className="modal-actions"><Button onClick={close} disabled={busy}>Cancel</Button><Button type="submit" kind="primary" disabled={busy}>{busy ? 'Saving…' : monitor ? 'Save changes' : 'Add monitor'}</Button></div>
    </form>
  </Modal>
}

function CountDescription({ data }: { data: OverviewData }) {
  return <span className="stat-status"><span><i className="text-good" />{data.operational} up</span><span><i className="text-warn" />{data.degraded} degraded</span><span><i className="text-bad" />{data.down} down</span></span>
}

type MonitorPage = { refresh: number; add: () => void }
export function Overview({ refresh, add }: MonitorPage) {
  const overview = useData<OverviewData>('/overview', refresh)
  const monitors = useData<Monitor[]>('/monitors', refresh)
  return <>
    <Header title="Overview"><Button kind="primary" onClick={add}><Plus size={17} /> Add monitor</Button></Header>
    <Load result={overview}>{data => <>
      <div className="stats">
        <Stat icon={Radio} label="Monitors" value={data.total} detail={<CountDescription data={data} />} tone="text-accent" />
        <Stat icon={TrendingUp} label="Overall uptime" value={percent(data.uptime)} detail="Last 24 hours" tone="text-good" />
        <Stat icon={Zap} label="Average response" value={latency(data.avgLatency)} detail="Last 24 hours" tone="text-accent" />
        <Stat icon={CircleAlert} label="Active incidents" value={data.activeIncidents} detail={<Link className="inline-link" to="/incidents">View incidents <ChevronRight size={13} /></Link>} tone={data.activeIncidents ? 'text-bad' : ''} />
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h2>Response time</h2><p>Average across monitors</p></div><span className="range-label"><Clock3 size={14} /> Last 24 hours</span></div>
        <Trend series={data.series ?? []} />
      </section>
    </>}</Load>
    <section className="panel">
      <div className="panel-heading"><div><h2>Monitors</h2><p>Current endpoint status</p></div><Link className="button" to="/monitors">All monitors <ArrowUpRight size={15} /></Link></div>
      <Load result={monitors}>{data => <MonitorTable monitors={data.slice(0, 5)} add={add} />}</Load>
    </section>
  </>
}

type Column = typeof columns[number][0]
type Sort = { key: Column; descending: boolean }

export function Monitors({ refresh, add }: MonitorPage) {
  const result = useData<Monitor[]>('/monitors', refresh)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false })
  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim()
    return (result.data ?? []).filter(monitor => {
      const state = monitor.state
      return (!filter || state === filter) && (!needle || `${monitor.name} ${monitor.url}`.toLowerCase().includes(needle))
    }).sort((left, right) => {
      const a = left[sort.key], b = right[sort.key]
      if (a == null) return b == null ? 0 : 1
      if (b == null) return -1
      return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * (sort.descending ? -1 : 1)
    })
  }, [result.data, query, filter, sort])
  function sortBy(key: Column) {
    setSort(previous => ({ key, descending: previous.key === key ? !previous.descending : false }))
  }
  return <>
    <Header eyebrow="Monitoring" title="Monitors" description="Configure checks and inspect endpoint availability."><Button kind="primary" onClick={add}><Plus size={17} /> Add monitor</Button></Header>
    <section className="panel">
      <div className="toolbar">
        <label className="search"><Search size={16} /><input type="search" placeholder="Search monitors…" aria-label="Search monitors" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="Filter by status" value={filter} onChange={event => setFilter(event.target.value)}><option value="">All statuses</option>{['operational', 'degraded', 'down', 'paused', 'unknown'].map(state => <option key={state} value={state}>{stateLabels[state]}</option>)}</select>
      </div>
      <Load result={result}>{data => <MonitorTable monitors={filtered} add={add} sort={sort} sortBy={sortBy} filtered={data.length > 0} clear={() => { setFilter(''); setQuery('') }} />}</Load>
    </section>
  </>
}

const columns = [['name', 'Endpoint'], ['state', 'Status'], ['uptime', 'Uptime (24h)'], ['avgLatency', 'Response (24h)'], ['lastCheckedAt', 'Last checked']] as const

function MonitorTable({ monitors, add, sort, sortBy, filtered, clear }: { monitors: Monitor[]; add: () => void; sort?: Sort; sortBy?: (key: Column) => void; filtered?: boolean; clear?: () => void }) {
  if (!monitors.length) return filtered
    ? <Empty icon={Search} title="No matching monitors" description="Try a different name, URL, or status."><Button onClick={clear}>Clear filters</Button></Empty>
    : <Empty icon={Globe} title="No monitors yet" description="Add an HTTP endpoint to start collecting uptime and response times."><Button kind="primary" onClick={add}><Plus size={16} /> Add your first monitor</Button></Empty>
  return <div className="table-scroll"><table className="data-table">
    <thead><tr>{columns.map(([key, label]) => <th scope="col" key={key} aria-sort={sort?.key === key ? sort.descending ? 'descending' : 'ascending' : undefined}>
      {sortBy ? <button className="sort" type="button" onClick={() => sortBy(key)}>{label}{sort?.key === key && (sort.descending ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button> : label}
    </th>)}<th scope="col"><span className="sr-only">Open details</span></th></tr></thead>
    <tbody>{monitors.map(monitor => <tr key={monitor.id}>
      <td><Link className="endpoint" to={`/monitors/${monitor.id}`}><span className="endpoint-icon"><Globe size={17} /></span><span><strong>{monitor.name}</strong><small title={monitor.url}>{monitor.url}</small></span></Link></td>
      <td><div className="monitor-state"><Badge state={monitor.state} />{monitor.activeIncident && <span className="active-incident"><CircleAlert size={12} /> Active incident</span>}</div></td><td className="numeric">{percent(monitor.uptime)}</td><td className="numeric">{latency(monitor.avgLatency)}</td><td className="muted">{dateTime(monitor.lastCheckedAt)}</td><td><Link className="row-action" aria-label={`View ${monitor.name}`} to={`/monitors/${monitor.id}`}><ChevronRight size={17} /></Link></td>
    </tr>)}</tbody>
  </table></div>
}

const periods = [['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']]

export function MonitorDetail({ refresh, reload, edit }: { refresh: number; reload: () => void; edit: (monitor: Monitor) => void }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [period, setPeriod] = useState('24h')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const result = useData<DetailData>(`/monitors/${id}?period=${period}`, refresh)

  async function change(action: 'pause' | 'resume' | 'delete') {
    setBusy(true)
    setError('')
    try {
      await request(`/monitors/${id}${action === 'delete' ? '' : '/' + action}`, { method: action === 'delete' ? 'DELETE' : 'POST' })
      reload()
      if (action === 'delete') navigate('/monitors')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Link to="/monitors" className="back"><ArrowLeft size={15} /> All monitors</Link>
    <Load result={result}>{({ monitor, metrics, series, checks, incidents, lastSuccess, lastFailure }) => <>
      <Header title={monitor.name} description={monitor.url}>
        <Badge state={monitor.state} />
        <Button onClick={() => edit(monitor)}><Pencil size={15} /> Edit</Button>
        <Button onClick={() => change(monitor.state === 'paused' ? 'resume' : 'pause')} disabled={busy}>{monitor.state === 'paused' ? <Play size={15} /> : <Pause size={15} />}{monitor.state === 'paused' ? 'Resume' : 'Pause'}</Button>
        <Button className="icon-button danger" aria-label="Delete monitor" onClick={() => { setConfirm(true); setError('') }}><Trash2 size={15} /></Button>
      </Header>
      {!confirm && <Feedback error={error} />}
      {confirm && <Modal title="Delete monitor" description={`Permanently delete ${monitor.name} and its check history?`} close={() => setConfirm(false)} busy={busy}>
        <Feedback error={error} /><div className="modal-actions"><Button onClick={() => setConfirm(false)} disabled={busy}>Cancel</Button><Button kind="danger-fill" onClick={() => change('delete')} disabled={busy}>{busy ? 'Deleting…' : 'Delete monitor'}</Button></div>
      </Modal>}
      <div className="detail-toolbar"><div className="flex flex-wrap gap-2"><span className="tag">{monitor.method} · HTTP {monitor.expectedStatus}</span><span className="tag">Every {duration(monitor.intervalSeconds)}</span><ExternalLink href={monitor.url}>Endpoint</ExternalLink></div>
        <div className="segments" aria-label="Time range">{periods.map(([value, label]) => <Button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</Button>)}</div>
      </div>
      <div className="stats">
        <Stat label="Uptime" value={percent(metrics.uptime)} icon={TrendingUp} tone="text-good" detail={`${metrics.checked} checks · ${metrics.missed} missing`} />
        <Stat label="Average response" value={latency(metrics.avgLatency)} icon={Zap} tone="text-accent" detail={`P95 ${latency(metrics.p95)}`} />
        <Stat label="Downtime" value={duration(metrics.downtimeSeconds)} icon={Timer} detail={`${metrics.incidentFrequency} incidents`} />
        <Stat label="Mean time to recovery" value={duration(metrics.mttrSeconds)} icon={Clock3} />
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h2>Response time</h2><p>Average latency per time bucket · UTC</p></div><span className="range-label">Last {period}</span></div>
        <Trend series={series} period={period} />
        <div className="detail-measures"><span>P50 <strong>{latency(metrics.p50)}</strong></span><span>P95 <strong>{latency(metrics.p95)}</strong></span><span>P99 <strong>{latency(metrics.p99)}</strong></span></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Availability history</h2><p>{period === '7d' ? 'Hourly buckets, with 24 hours per row' : period === '24h' ? 'Hourly check results' : 'Daily check results'} · UTC</p></div></div>
        <div className="panel-body"><Strip series={series} /></div>
        <div className="detail-measures"><span>Last success <strong>{dateTime(lastSuccess)}</strong></span><span>Last failure <strong>{dateTime(lastFailure)}</strong></span><span>TLS expires <strong>{expiryDate(monitor.certificateExpiresAt)}</strong></span><span>Domain expires <strong>{expiryDate(monitor.domainExpiresAt)}</strong></span></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Check configuration</h2></div></div>
        <dl className="monitor-config">
          <div><dt>Timeout</dt><dd>{latency(monitor.timeoutMs)}</dd></div>
          <div><dt>Slow response threshold</dt><dd>{latency(monitor.slowMs)}</dd></div>
          <div><dt>Outage confirmation</dt><dd>{monitor.failureThreshold} consecutive failures</dd></div>
          <div><dt>Recovery confirmation</dt><dd>{monitor.recoveryThreshold} healthy checks</dd></div>
          <div><dt>Incident alerts</dt><dd>{monitor.alertsEnabled ? 'On' : 'Off'}</dd></div>
          <div><dt>Expected content</dt><dd>{monitor.expectedContent || 'No content check'}</dd></div>
        </dl>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Recent checks</h2>{checks.length > 0 && <p>{checks.length} results in this period</p>}</div></div>
        {checks.length ? <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Scheduled</th><th>Checked</th><th>Result</th><th>HTTP</th><th>Latency</th><th>Error</th></tr></thead>
          <tbody>{checks.map(check => <tr key={check.scheduledAt}><td>{dateTime(check.scheduledAt)}</td><td>{dateTime(check.checkedAt)}</td><td><Badge state={check.checkedAt == null ? 'pending' : check.ok ? 'operational' : 'down'} label={check.checkedAt == null ? 'Missing' : check.ok ? 'Passed' : 'Failed'} /></td><td className="numeric">{check.httpStatus ?? '—'}</td><td className="numeric">{latency(check.latencyMs)}</td><td className="muted">{check.error === 'missed_schedule' ? 'Check expired before completion' : check.error === 'monitor_changed' ? 'Monitor configuration changed' : check.error || '—'}</td></tr>)}</tbody>
        </table></div> : <Empty icon={Activity} title="No check results" description="Results appear after the endpoint is checked." />}
      </section>
      {incidents?.length > 0 && <section className="panel">
        <div className="panel-heading"><div><h2>Incidents</h2><p>Incidents in this period</p></div><Link className="button" to="/incidents">All incidents <ArrowUpRight size={15} /></Link></div>
        <ul className="simple-list">{incidents.map(incident => <li key={incident.id}><Link to={`/incidents#${incident.id}`}>{incident.title}</Link><span className="muted">{dateTime(incident.openedAt)}</span></li>)}</ul>
      </section>}
    </>}</Load>
  </>
}
