import { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowRight, Bell, ChevronRight, CircleAlert, Globe, LayoutGrid, LogOut, Moon, Radio, Sun } from 'lucide-react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { Badge, Button, Empty, Feedback, Field, Load, Logo, Strip, StripLegend } from './components'
import { calendarDate, dateTime, duration, errorText, formText, percent, request, useData, type Monitor, type PublicPage, type Session, type User } from './data'
import { Channels, Incidents, StatusPages } from './management'
import { MonitorDetail, MonitorForm, Monitors, Overview } from './monitors'
import './styles.css'

const nav = [
  { title: 'Monitoring', links: [['/', 'Overview', LayoutGrid], ['/monitors', 'Monitors', Radio], ['/incidents', 'Incidents', CircleAlert]] },
  { title: 'Communication', links: [['/channels', 'Alert channels', Bell], ['/status-pages', 'Status pages', Globe]] },
] as const

function Auth({ onSignIn }: { onSignIn: (user: User) => void }) {
  const [signup, setSignup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const account = {
        email: formText(values, 'email').trim(),
        password: formText(values, 'password'),
        ...(signup ? { name: formText(values, 'name').trim() } : {}),
      }
      const data = await request<Session>(`/auth/${signup ? 'sign-up' : 'sign-in'}/email`, {
        method: 'POST',
        body: account,
        headers: signup ? { 'x-registration-key': formText(values, 'invite') } : undefined,
      })
      const user = data?.user ?? (await request<Session>('/auth/get-session'))?.user
      if (!user) throw new Error('Sign in to continue with your account.')
      onSignIn(user)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <main className="auth">
    <section className="auth-banner">
      <div className="auth-brand"><Logo /></div>
      <div className="auth-graphic" aria-hidden="true"><span className="pulse-ring ring-outer" /><span className="pulse-ring ring-middle" /><span className="pulse-ring ring-inner" /><Activity size={104} strokeWidth={1.35} /></div>
      <div className="auth-copy"><h1>Know when your<br />services need you.</h1><p>Endpoint monitoring, incident management, and public status pages in one workspace.</p></div>
    </section>
    <section className="auth-main"><div className="auth-form">
      <div className="mobile-brand"><Logo /></div>
      <div className="eyebrow">Lucid Monitor workspace</div>
      <h2>{signup ? 'Create your account' : 'Sign in'}</h2>
      <p>{signup ? 'Enter the registration key for this Lucid Monitor instance.' : 'View monitor health and manage incident response.'}</p>
      <form className="stack" onSubmit={submit}>
        {signup && <Field label="Full name"><input name="name" type="text" autoComplete="name" required /></Field>}
        <Field label="Email"><input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></Field>
        <Field label="Password" help={signup ? 'Use at least 12 characters.' : undefined}><input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : undefined} required /></Field>
        {signup && <Field label="Registration key"><input name="invite" type="password" required autoComplete="off" /></Field>}
        <Feedback error={error} />
        <Button type="submit" kind="primary" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'} <ArrowRight size={17} /></Button>
      </form>
      <div className="auth-switch">{signup ? 'Already have an account?' : 'Have a registration key?'} <button type="button" onClick={() => { setSignup(!signup); setError('') }}>{signup ? 'Sign in' : 'Create account'}</button></div>
    </div></section>
  </main>
}

function Dashboard({ user, signOut }: { user: User; signOut: () => void }) {
  const location = useLocation()
  const [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<{ monitor?: Monitor } | null>(null)
  const [signOutError, setSignOutError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const reload = () => setRefresh(value => value + 1)
  const add = () => setDialog({})
  const edit = (monitor: Monitor) => setDialog({ monitor })
  const breadcrumb = [...nav[0].links, ...nav[1].links].find(([path]) => path === location.pathname)?.[1] ?? 'Monitor details'

  useEffect(() => {
    const timer = setInterval(() => setRefresh(value => value + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (location.hash) {
      const scroll = () => document.getElementById(location.hash.slice(1))?.scrollIntoView()
      scroll()
      const retry = setTimeout(scroll, 450)
      return () => clearTimeout(retry)
    }
    window.scrollTo(0, 0)
  }, [location.pathname, location.hash])

  async function exit() {
    setSigningOut(true)
    setSignOutError('')
    try {
      await request('/auth/sign-out', { method: 'POST', body: {} })
      signOut()
    } catch (failure) {
      setSignOutError(errorText(failure))
    } finally {
      setSigningOut(false)
    }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar">
      <NavLink to="/" className="sidebar-brand"><Logo /></NavLink>
      <nav aria-label="Workspace navigation">{nav.map(group => <div className="nav-group" key={group.title}>
        <div className="nav-title">{group.title}</div>
        {group.links.map(([path, label, Icon]) => <NavLink className="nav-link" end={path === '/'} key={path} to={path}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></NavLink>)}
      </div>)}</nav>
      <div className="sidebar-bottom">
        <div className="account"><span className="avatar" aria-hidden="true">{(user.name || user.email || 'U').slice(0, 1).toUpperCase()}</span><span className="account-label"><strong>{user.name || user.email}</strong><small>{user.email}</small></span><Button className="icon-button logout" onClick={exit} disabled={signingOut} aria-label="Sign out" title="Sign out"><LogOut size={16} /></Button></div>
      </div>
    </aside>
    <div className="workspace">
      <div className="topbar"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={13} /><strong>{breadcrumb}</strong></div><span className="tz">UTC</span></div>
      <main id="main" className="content">
        <Feedback error={signOutError} />
        <Routes>
          <Route path="/" element={<Overview refresh={refresh} add={add} />} />
          <Route path="/monitors" element={<Monitors refresh={refresh} add={add} />} />
          <Route path="/monitors/:id" element={<MonitorDetail refresh={refresh} reload={reload} edit={edit} />} />
          <Route path="/incidents" element={<Incidents refresh={refresh} reload={reload} />} />
          <Route path="/channels" element={<Channels refresh={refresh} reload={reload} />} />
          <Route path="/status-pages" element={<StatusPages refresh={refresh} reload={reload} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
    {dialog && <MonitorForm monitor={dialog.monitor} close={() => setDialog(null)} save={reload} />}
  </div>
}

function PrivateApp() {
  const session = useData<Session>('/auth/get-session')
  const [override, setOverride] = useState<User | null>()
  return <Load result={session}>{data => {
    const user = override === undefined ? data?.user : override
    return user ? <Dashboard user={user} signOut={() => setOverride(null)} /> : <Auth onSignIn={setOverride} />
  }}</Load>
}

const publicHeadline = {
  operational: 'All systems operational',
  up: 'All systems operational',
  degraded: 'Service performance degraded',
  down: 'A service disruption is active',
  paused: 'Monitoring paused',
  pending: 'Awaiting check results',
  unknown: 'Awaiting check results',
}

function PublicStatus() {
  const { slug = '' } = useParams()
  const [refresh, setRefresh] = useState(0)
  const result = useData<PublicPage>(`/public/${encodeURIComponent(slug)}`, refresh)
  const [theme, setTheme] = useState(() => localStorage.getItem('lucid-status-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    const timer = setInterval(() => setRefresh(value => value + 1), 30000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    document.title = result.data ? `${result.data.title} · Status` : 'Service status'
    return () => { document.title = 'Lucid Monitor' }
  }, [result.data])

  function toggleTheme() {
    const value = theme === 'dark' ? 'light' : 'dark'
    setTheme(value)
    localStorage.setItem('lucid-status-theme', value)
  }
  return <main className="public" data-theme={theme}>
    <div className="public-wrap">
      <div className="public-top"><div className="public-label"><Activity size={19} /> Service status</div><Button className="icon-button" onClick={toggleTheme} aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</Button></div>
      <Load result={result}>{data => <>
        <header className="public-header"><h1>{data.title}</h1>{data.description && <p>{data.description}</p>}</header>
        <div className={`public-health state-${data.state}`}><i />{publicHeadline[data.state] ?? 'Service status unavailable'}</div>
        <section className="public-section"><h2>Components</h2><div className="panel">{data.monitors.length ? data.monitors.map(monitor => <article className="public-monitor" key={monitor.id}>
          <div><h3>{monitor.name}</h3><Badge state={monitor.state} /></div>
          <Strip series={monitor.series} legend={false} />
          <div className="public-period"><span>{monitor.series[0] ? calendarDate(monitor.series[0].time) : ''}</span><strong>{monitor.uptime == null ? 'Uptime unavailable' : `${percent(monitor.uptime)} uptime`}</strong><span>{monitor.series.length > 1 ? calendarDate(monitor.series[monitor.series.length - 1].time) : ''}</span></div>
        </article>) : <Empty title="No components listed" />}</div>{data.monitors.length > 0 && <StripLegend />}</section>
        <section className="public-section"><h2>Incident history</h2><div className="panel">{data.incidents.length ? data.incidents.map(incident => <article className="public-incident" key={incident.id}>
          <Badge state={incident.resolvedAt ? 'operational' : 'down'} label={incident.resolvedAt ? 'Resolved' : 'Active'} /><h3>{incident.title}</h3><p>{incident.monitorName} · {dateTime(incident.openedAt)}{incident.resolvedAt && ` · Duration ${duration((incident.resolvedAt - incident.openedAt) / 1000)}`}</p>
        </article>) : <Empty icon={CircleAlert} title="No incidents reported" />}</div></section>
      </>}</Load>
      <footer className="public-footer"><Logo /></footer>
    </div>
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element missing')
createRoot(root).render(
  <BrowserRouter><Routes><Route path="/status/:slug" element={<PublicStatus />} /><Route path="*" element={<PrivateApp />} /></Routes></BrowserRouter>,
)
