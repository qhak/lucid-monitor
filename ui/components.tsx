import { cloneElement, useEffect, useId, useRef, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Activity, ArrowUpRight, CircleAlert, CircleCheck, LoaderCircle, Radio, X, type LucideIcon } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { calendarDate, clockTime, dateTime, latency, stateLabels, type Point } from './data'

export function Logo() {
  return <span className="brand"><span className="brand-mark"><Activity size={19} strokeWidth={2.45} /></span><span>Lucid<span className="brand-sub">Monitor</span></span></span>
}

export function Button({ children, kind = '', className = '', ...props }: ComponentProps<'button'> & { kind?: string }) {
  return <button type="button" className={`button ${kind} ${className}`} {...props}>{children}</button>
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="button" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={15} /></a>
}

export function Badge({ state, label }: { state: string; label?: string }) {
  return <span className={`badge state-${state}`}><i />{label ?? stateLabels[state] ?? state}</span>
}

export function Header({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return <header className="page-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="head-actions">{children}</div>}</header>
}

export function Empty({ icon: Icon = Radio, title, description, children }: { icon?: LucideIcon; title: string; description?: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon size={22} strokeWidth={1.65} /></span><h3>{title}</h3>{description && <p>{description}</p>}{children}</div>
}

export function Load<T>({ result, children }: { result: { data: T | undefined; error: string | null; retry: () => void }; children: (data: T) => ReactNode }) {
  if (result.error) return <div className="panel"><Empty icon={CircleAlert} title="Could not load data" description={result.error}><Button onClick={result.retry}>Try again</Button></Empty></div>
  if (result.data === undefined) return <div className="panel loading" role="status"><LoaderCircle size={18} className="spin" /> Loading…</div>
  return children(result.data)
}

export function Stat({ icon: Icon, label, value, detail, tone }: { icon?: LucideIcon; label: string; value: ReactNode; detail?: ReactNode; tone?: string }) {
  return <article className="panel stat"><div className="stat-label"><span>{label}</span>{Icon && <Icon className={tone ?? ''} size={17} strokeWidth={1.7} />}</div><div className="stat-value">{value}</div>{detail && <div className="stat-detail">{detail}</div>}</article>
}

export function Modal({ title, description, children, close, busy }: { title: string; description?: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const active = document.activeElement
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLElement>('form input:not([disabled]), form textarea:not([disabled]), form select:not([disabled])')?.focus()
    return () => {
      element?.close()
      if (active instanceof HTMLElement && active.isConnected) active.focus()
    }
  }, [])
  return <dialog className="modal" ref={dialog} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <div className="modal-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><Button className="icon-button" onClick={close} disabled={busy} aria-label="Close"><X size={18} /></Button></div>
    {children}
  </dialog>
}

export function Field({ label, help, children, wide }: {
  label: string; help?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; wide?: boolean;
}) {
  const id = useId()
  return <div className={`field ${wide ? 'wide' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {cloneElement(children, { id, 'aria-describedby': help ? `${id}-help` : undefined })}
    {help && <small id={`${id}-help`}>{help}</small>}
  </div>
}

export function Feedback({ error, status }: { error?: string; status?: string }) {
  if (error) return <p className="feedback error" role="alert"><CircleAlert size={16} />{error}</p>
  if (status) return <p className="feedback success" role="status"><CircleCheck size={16} />{status}</p>
  return null
}

export function Trend({ series, period = '24h' }: { series: Point[]; period?: string }) {
  const gradient = useId().replaceAll(':', '')
  const hasResults = series.some(point => point.avgLatency != null)
  return <div className="trend">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#a892fc" stopOpacity={0.35} /><stop offset="100%" stopColor="#a892fc" stopOpacity={0.02} /></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="4 5" />
        <XAxis dataKey="time" minTickGap={26} tickFormatter={period === '24h' ? clockTime : calendarDate} axisLine={false} tickLine={false} tickMargin={10} />
        <YAxis width={61} tickCount={5} domain={hasResults ? [0, 'auto'] : [0, 1000]} tickFormatter={value => `${value} ms`} axisLine={false} tickLine={false} />
        {hasResults && <Tooltip labelFormatter={value => dateTime(typeof value === 'number' ? value : undefined)} formatter={value => [latency(typeof value === 'number' ? value : undefined), 'Average response time']} />}
        <Area type="monotone" dataKey="avgLatency" stroke="#a892fc" strokeWidth={2} fill={`url(#${gradient})`} isAnimationActive={false} dot={{ r: 2, fill: '#a892fc', strokeWidth: 0 }} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
    {!hasResults && <div className="trend-empty"><Activity size={17} /> Waiting for response time data</div>}
  </div>
}

type AvailabilityPoint = Omit<Point, 'avgLatency'>

function bucketState(point: AvailabilityPoint) {
  if (point.failed) return point.passed ? 'degraded' : 'down'
  if (point.missing) return 'missing'
  return point.passed ? 'operational' : 'unobserved'
}

export function Strip({ series = [], legend = true }: { series?: AvailabilityPoint[]; legend?: boolean }) {
  return <div className="strip-wrap">
    {series.length > 0 ? <div className={`strip ${series.length > 90 ? 'hours-grid' : ''}`} role="list" aria-label="Availability history">
      {series.map((point, index) => {
        const label = `${dateTime(point.time)} · ${point.passed ?? 0} passed, ${point.failed ?? 0} failed, ${point.missing ?? 0} missing`
        return <span key={point.time ?? index} role="listitem" aria-label={label} title={label} className={`bucket ${bucketState(point)}`} />
      })}
    </div> : <p className="muted">No checks for this period.</p>}
    {legend && <StripLegend />}
  </div>
}

export function StripLegend() {
  return <div className="strip-legend"><span><i className="bucket operational" />Passed</span><span><i className="bucket degraded" />Mixed</span><span><i className="bucket down" />Failed</span><span><i className="bucket missing" />Missing</span><span><i className="bucket unobserved" />No checks</span></div>
}
