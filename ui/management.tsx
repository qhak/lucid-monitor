import { useState, type FormEvent, type ReactNode } from 'react'
import { Bell, CircleAlert, CircleCheck, Globe, Mail, MessageSquare, Pencil, Plus, Trash2, Webhook } from 'lucide-react'
import { Badge, Button, Empty, ExternalLink, Feedback, Field, Header, Load, Modal } from './components'
import { dateTime, duration, errorText, formText, request, useData, type Channel, type ChannelKind, type Delivery, type Incident, type Monitor, type StatusPage } from './data'

function Editor({ title, primary, close, onSubmit, children, danger = false }: {
  title: string; primary: string; close: () => void; onSubmit: (values: FormData) => Promise<void>; children: ReactNode; danger?: boolean;
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await onSubmit(values)
      close()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={title} close={close} busy={busy}><form onSubmit={submit}>
    <div className="fields">{children}</div><Feedback error={error} />
    <div className="modal-actions"><Button onClick={close} disabled={busy}>Cancel</Button><Button kind={danger ? 'danger-fill' : 'primary'} type="submit" disabled={busy}>{busy ? 'Working…' : primary}</Button></div>
  </form></Modal>
}

function Remove({ title, name, path, close, reload }: { title: string; name: string; path: string; close: () => void; reload: () => void }) {
  return <Editor title={title} primary="Delete" close={close} danger onSubmit={async () => { await request(path, { method: 'DELETE' }); reload() }}>
    <p className="muted wide">Permanently delete {name}?</p>
  </Editor>
}

type ManagementPage = { refresh: number; reload: () => void }

function PageControls({ offset, next, go }: { offset: number; next: number | null; go: (offset: number) => void }) {
  if (offset === 0 && next === null) return null
  return <div className="pagination" aria-label="List pages"><Button onClick={() => go(Math.max(0, offset - 50))} disabled={!offset}>Previous</Button><Button onClick={() => go(next ?? offset)} disabled={next === null}>Next</Button></div>
}

export function Incidents({ refresh, reload }: ManagementPage) {
  const [offset, setOffset] = useState(0)
  const result = useData<Incident[]>(`/incidents?offset=${offset}`, refresh)
  const monitors = useData<Monitor[]>('/monitors', refresh)
  const [filter, setFilter] = useState('all')
  const [dialog, setDialog] = useState<{ type: 'open' } | { type: 'note'; incident: Incident } | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  async function update(incident: Incident, action: 'acknowledge' | 'resolve' | 'annotate', body?: { message: string }) {
    await request(`/incidents/${incident.id}/${action}`, { method: 'POST', body })
    reload()
  }

  async function act(incident: Incident, action: 'acknowledge' | 'resolve') {
    setPending(incident.id)
    setError('')
    try { await update(incident, action) } catch (failure) { setError(errorText(failure)) } finally { setPending('') }
  }

  return <>
    <Header eyebrow="Monitoring" title="Incidents" description="Investigate disruptions, record updates, and track recovery."><Button kind="primary" onClick={() => setDialog({ type: 'open' })} disabled={!monitors.data?.length}><Plus size={16} /> Open incident</Button></Header>
    <Feedback error={error} />
    <div className="segments" aria-label="Filter incidents">{[['all', 'All incidents'], ['active', 'Active'], ['resolved', 'Resolved']].map(([value, label]) => <Button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setOffset(0) }}>{label}</Button>)}</div>
    <Load result={result}>{data => {
      const shown = data.filter(incident => filter === 'all' || (filter === 'resolved') === Boolean(incident.resolvedAt))
      return shown.length ? <div className="stack">{shown.map(incident => <article className="panel incident" key={incident.id} id={incident.id}>
        <div className="panel-heading"><div><Badge state={incident.resolvedAt ? 'operational' : incident.acknowledgedAt ? 'degraded' : 'down'} label={incident.resolvedAt ? 'Resolved' : incident.acknowledgedAt ? 'Acknowledged' : 'Open'} /><h2>{incident.title}</h2><p>{incident.monitorName} · Opened {dateTime(incident.openedAt)}{incident.resolvedAt && ` · Resolved in ${duration((incident.resolvedAt - incident.openedAt) / 1000)}`}</p></div>
          <div className="head-actions">
            <Button onClick={() => setDialog({ type: 'note', incident })}><MessageSquare size={15} /> Add note</Button>
            {!incident.resolvedAt && !incident.acknowledgedAt && <Button disabled={Boolean(pending)} onClick={() => act(incident, 'acknowledge')}>Acknowledge</Button>}
            {!incident.resolvedAt && <Button disabled={Boolean(pending)} onClick={() => act(incident, 'resolve')}><CircleCheck size={15} /> Resolve</Button>}
          </div>
        </div>
        {incident.events.length > 0 && <ol className="event-list">{incident.events.map((event, index) => <li key={`${event.createdAt}-${index}`}><i /><div><strong>{event.message || event.kind}</strong><small>{dateTime(event.createdAt)}</small></div></li>)}</ol>}
      </article>)}</div> : <section className="panel"><Empty icon={CircleAlert} title={filter === 'all' ? 'No incidents yet' : `No ${filter} incidents`} description="Incidents appear here when checks fail or an incident is opened manually." /></section>
    }}</Load>
    {result.data && <PageControls offset={offset} next={result.nextOffset} go={setOffset} />}
    {dialog?.type === 'open' && <Editor title="Open incident" primary="Open incident" close={() => setDialog(null)} onSubmit={async form => {
      await request('/incidents', { method: 'POST', body: { monitorId: formText(form, 'monitorId'), title: formText(form, 'title').trim() } })
      setFilter('all')
      setOffset(0)
      reload()
    }}>
      <Field label="Monitor" wide><select name="monitorId" required>{monitors.data?.map(monitor => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}</select></Field>
      <Field label="Incident title" wide><input name="title" required maxLength={150} placeholder="Endpoint returning errors" /></Field>
    </Editor>}
    {dialog?.type === 'note' && <Editor title="Add incident note" primary="Add note" close={() => setDialog(null)} onSubmit={form => update(dialog.incident, 'annotate', { message: formText(form, 'message').trim() })}>
      <Field label="Note" wide><textarea name="message" rows={4} required maxLength={1000} /></Field>
    </Editor>}
  </>
}

const channelKinds = { email: 'Email', discord: 'Discord', webhook: 'Webhook' }
const channelIcons = { email: Mail, discord: MessageSquare, webhook: Webhook }
const events = [['opened', 'Opened'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved']]

export function Channels({ refresh, reload }: ManagementPage) {
  const [offset, setOffset] = useState(0)
  const channels = useData<Channel[]>('/channels', refresh)
  const deliveries = useData<Delivery[]>(`/deliveries?offset=${offset}`, refresh)
  const [dialog, setDialog] = useState<{ type: 'add' } | { type: 'edit' | 'delete'; channel: Channel } | null>(null)
  const [kind, setKind] = useState<ChannelKind>('email')
  const channel = dialog?.type === 'edit' ? dialog.channel : undefined
  return <>
    <Header eyebrow="Communication" title="Alert channels" description="Send incident updates to email, Discord, and webhook endpoints."><Button kind="primary" onClick={() => { setDialog({ type: 'add' }); setKind('email') }}><Plus size={16} /> Add channel</Button></Header>
    <section className="panel"><div className="panel-heading"><div><h2>Channels</h2><p>Destinations and event subscriptions</p></div></div>
      <Load result={channels}>{items => items.length ? <ul className="management-list">{items.map(channel => {
        const Icon = channelIcons[channel.kind] ?? Bell
        return <li key={channel.id}><div className="endpoint"><span className="endpoint-icon"><Icon size={17} /></span><span><strong>{channel.name}</strong><small>{channelKinds[channel.kind]} · {channel.events.join(', ')} · {duration(channel.cooldownSeconds)} cooldown</small></span></div><div className="head-actions"><Button className="icon-button" aria-label={`Edit ${channel.name}`} onClick={() => { setKind(channel.kind); setDialog({ type: 'edit', channel }) }}><Pencil size={16} /></Button><Button className="icon-button danger" aria-label={`Delete ${channel.name}`} onClick={() => setDialog({ type: 'delete', channel })}><Trash2 size={16} /></Button></div></li>
      })}</ul> : <Empty icon={Bell} title="No alert channels" description="Add a channel to receive incident updates." />}</Load>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Delivery history</h2><p>Recent delivery outcomes</p></div></div>
      <Load result={deliveries}>{items => items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Channel</th><th>Monitor</th><th>Event</th><th>Status</th><th>Attempts</th><th>Created</th><th>Error</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.id}><td>{item.channelName}</td><td>{item.monitorName}</td><td>{item.eventKind}</td><td>{item.status}</td><td className="numeric">{item.attempts}</td><td>{dateTime(item.createdAt)}</td><td className="muted">{item.error ?? '—'}</td></tr>)}</tbody>
      </table></div> : <Empty icon={Mail} title="No deliveries yet" description="Delivery attempts for incident events appear here." />}</Load>
      {deliveries.data && <PageControls offset={offset} next={deliveries.nextOffset} go={setOffset} />}
    </section>
    {dialog && dialog.type !== 'delete' && <Editor title={channel ? 'Edit alert channel' : 'Add alert channel'} primary={channel ? 'Save changes' : 'Add channel'} close={() => setDialog(null)} onSubmit={async form => {
      const selected = form.getAll('events')
      if (!selected.length) throw new Error('Select at least one incident event.')
      const destination = formText(form, 'destination').trim()
      await request(channel ? `/channels/${channel.id}` : '/channels', { method: channel ? 'PATCH' : 'POST', body: {
        name: formText(form, 'name').trim(), ...(channel ? {} : { kind }), ...(destination ? { destination } : {}),
        events: selected, cooldownSeconds: Number(formText(form, 'cooldown')),
      } })
      reload()
    }}>
      <Field label="Name"><input name="name" required maxLength={100} placeholder="On-call alerts" defaultValue={channel?.name} /></Field>
      <Field label="Channel type"><select value={kind} disabled={Boolean(channel)} onChange={event => setKind(event.target.value as ChannelKind)}>{Object.entries(channelKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label={kind === 'email' ? 'Email address' : 'Webhook URL'} help={channel ? 'Leave blank to keep the current destination.' : undefined} wide><input key={kind} name="destination" required={!channel} maxLength={2048} type={kind === 'email' ? 'email' : 'url'} /></Field>
      <Field label="Cooldown (seconds)" wide><input name="cooldown" type="number" required min="0" max="86400" defaultValue={channel?.cooldownSeconds ?? 300} /></Field>
      <fieldset className="wide"><legend>Incident events</legend><div className="flex flex-wrap gap-3">{events.map(([value, label]) => <label className="check-label" key={value}><input type="checkbox" name="events" value={value} defaultChecked={channel ? channel.events.includes(value) : true} />{label}</label>)}</div></fieldset>
    </Editor>}
    {dialog?.type === 'delete' && <Remove title="Delete alert channel" name={dialog.channel.name} path={`/channels/${dialog.channel.id}`} close={() => setDialog(null)} reload={reload} />}
  </>
}

export function StatusPages({ refresh, reload }: ManagementPage) {
  const pages = useData<StatusPage[]>('/status-pages', refresh)
  const monitors = useData<Monitor[]>('/monitors', refresh)
  const [dialog, setDialog] = useState<{ type: 'create' } | { type: 'edit' | 'delete'; page: StatusPage } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState('')
  const page = dialog && 'page' in dialog ? dialog.page : undefined
  async function copy(item: StatusPage) {
    setError('')
    try {
      await navigator.clipboard.writeText(`${location.origin}/status/${item.slug}`)
      setCopied(item.id)
    } catch {
      setError('Could not copy the URL. Open the page to copy it from your address bar.')
    }
  }
  return <>
    <Header eyebrow="Communication" title="Status pages" description="Publish endpoint health and incident history for your users."><Button kind="primary" onClick={() => setDialog({ type: 'create' })} disabled={!monitors.data?.length}><Plus size={16} /> Create status page</Button></Header>
    <Feedback error={error} />
    <section className="panel"><div className="panel-heading"><div><h2>Published pages</h2><p>Public URLs and included monitors</p></div></div>
      <Load result={pages}>{items => items.length ? <ul className="management-list">{items.map(item => <li key={item.id}>
        <div className="endpoint"><span className="endpoint-icon"><Globe size={17} /></span><span><strong>{item.title}</strong><small>/status/{item.slug} · {item.monitorIds.length} {item.monitorIds.length === 1 ? 'monitor' : 'monitors'}</small></span></div>
        <div className="head-actions"><ExternalLink href={`/status/${item.slug}`}>Open page</ExternalLink><Button onClick={() => copy(item)}>{copied === item.id ? 'Copied' : 'Copy URL'}</Button><Button className="icon-button" aria-label={`Edit ${item.title}`} onClick={() => setDialog({ type: 'edit', page: item })}><Pencil size={16} /></Button><Button className="icon-button danger" aria-label={`Delete ${item.title}`} onClick={() => setDialog({ type: 'delete', page: item })}><Trash2 size={16} /></Button></div>
      </li>)}</ul> : <Empty icon={Globe} title="No status pages yet" description={monitors.data?.length === 0 ? 'Add a monitor to publish a public status page.' : 'Create a public page to share availability with your users.'} />}</Load>
    </section>
    {dialog && dialog.type !== 'delete' && <Editor title={page ? 'Edit status page' : 'Create status page'} primary={page ? 'Save changes' : 'Create page'} close={() => setDialog(null)} onSubmit={async form => {
      const monitorIds = form.getAll('monitorIds')
      if (monitorIds.length === 0 || monitorIds.length > 20) throw new Error('Select between 1 and 20 monitors.')
      await request(page ? `/status-pages/${page.id}` : '/status-pages', { method: page ? 'PATCH' : 'POST', body: { title: formText(form, 'title').trim(), slug: formText(form, 'slug').trim(), description: formText(form, 'description').trim(), monitorIds } })
      reload()
    }}>
      <Field label="Page title" wide><input name="title" required maxLength={100} defaultValue={page?.title} placeholder="Service status" /></Field>
      <Field label="URL slug" help="Lowercase letters, numbers, and hyphens." wide><input name="slug" required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={page?.slug} placeholder="service-status" /></Field>
      <Field label="Description" wide><textarea name="description" rows={3} maxLength={500} defaultValue={page?.description} /></Field>
      <fieldset className="wide"><legend>Visible monitors</legend><Load result={monitors}>{items => items.length ? <div className="check-list">{items.map(monitor => <label className="check-label" key={monitor.id}><input type="checkbox" name="monitorIds" value={monitor.id} defaultChecked={page?.monitorIds.includes(monitor.id)} />{monitor.name}</label>)}</div> : <p className="muted">Add monitors from the Monitors page to include them here.</p>}</Load></fieldset>
    </Editor>}
    {dialog?.type === 'delete' && <Remove title="Delete status page" name={dialog.page.title} path={`/status-pages/${dialog.page.id}`} close={() => setDialog(null)} reload={reload} />}
  </>
}
