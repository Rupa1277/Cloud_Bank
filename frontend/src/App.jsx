import { useEffect, useState, useCallback } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth } from './firebase'
import { api, inr, when } from './api'

const newKey = () => crypto.randomUUID()

function Login() {
  const [mode, setMode] = useState('login'), [f, setF] = useState({ name: '', email: '', password: '' }), [msg, setMsg] = useState('')
  const submit = async (e) => {
    e.preventDefault(); setMsg('')
    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, f.email, f.password)
        await api('/account/init', { method: 'POST', body: { name: f.name } })
        await auth.currentUser.getIdToken(true)            // refresh so the new role claim is in the JWT
      } else await signInWithEmailAndPassword(auth, f.email, f.password)
    } catch (err) { setMsg(err.message.replace('Firebase: ', '')) }
  }
  return (<div className="landing">
    <header className="landing-nav"><a className="brand" href="#home"><span className="brand-mark">C</span> Cloud Bank</a>
      <span className="landing-nav-note">Banking, made simple</span></header>
    <main className="landing-main" id="home">
      <section className="hero-copy">
        <span className="eyebrow"><span className="eyebrow-dot" /> YOUR MONEY, IN CLEAR VIEW</span>
        <h1>A simpler way to stay on top of your money.</h1>
        <p className="hero-description">One secure place to check your balance, move money, and keep track of every transaction.</p>
        <div className="hero-points">
          <div><span className="point-icon">↗</span><span><b>Send with confidence</b><small>Clear transfer details, every time.</small></span></div>
          <div><span className="point-icon">▤</span><span><b>Your activity, organized</b><small>History and statements in one place.</small></span></div>
          <div><span className="point-icon">◷</span><span><b>Payments on your schedule</b><small>Set up recurring payments when you need them.</small></span></div>
        </div>
        <p className="demo-note">A digital banking experience for simulated money.</p>
      </section>
      <section className="card auth-card">
        <span className="auth-kicker">{mode === 'signup' ? 'GET STARTED' : 'WELCOME BACK'}</span>
        <h2>{mode === 'signup' ? 'Create your account' : 'Sign in to your account'}</h2>
        <p className="muted">{mode === 'signup' ? 'It only takes a moment to get started.' : 'Your account is ready when you are.'}</p>
        <form onSubmit={submit}>
          {mode === 'signup' && <label>Full name<input required autoComplete="name" placeholder="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>}
          <label>Email address<input required type="email" autoComplete="email" placeholder="you@example.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>Password<input required type="password" minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder="At least 6 characters" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
          <button className="btn auth-submit">{mode === 'signup' ? 'Create account' : 'Sign in'} <span aria-hidden="true">→</span></button>
        </form>
        {msg && <div className="bad" role="alert">{msg}</div>}
        <p className="auth-switch">{mode === 'login' ? 'New to Cloud Bank?' : 'Already have an account?'}
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg('') }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
        <p className="auth-security"><span aria-hidden="true">▣</span> Secure sign-in powered by Firebase Authentication</p>
      </section>
    </main>
    <footer className="landing-footer">Cloud Bank <span>·</span> A simulated banking experience</footer>
  </div>)
}

function Money({ title, path, onDone }) {                // deposit / withdraw
  const [amount, setAmount] = useState(''), [key, setKey] = useState(newKey), [msg, setMsg] = useState(null)
  const go = async (e) => { e.preventDefault(); setMsg(null)
    try { await api(path, { method: 'POST', body: { amount }, idem: key }); setMsg({ ok: 'Done' }); setAmount(''); setKey(newKey()); onDone() }
    catch (err) { setMsg({ bad: err.message }) } }
  return (<form className="card" onSubmit={go}><h3>{title}</h3>
    <input required type="number" min="1" step="0.01" placeholder="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
    <button className="btn alt">{title}</button>{msg && <div className={msg.ok ? 'ok' : 'bad'} style={{ marginTop: 8 }}>{msg.ok || msg.bad}</div>}</form>)
}

function Transfer({ onDone }) {
  const [f, setF] = useState({ toAccount: '', amount: '', note: '' }), [key, setKey] = useState(newKey), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false)
  const go = async (e) => { e.preventDefault(); setMsg(null); setBusy(true)
    try {                                                 // the SAME key is reused if the request is retried -> no double charge
      const r = await api('/transfer', { method: 'POST', body: f, idem: key })
      setMsg({ ok: `Transfer complete${r.duplicate ? ' (duplicate request ignored)' : ''}. New balance ${inr(r.newBalance)}` })
      setF({ toAccount: '', amount: '', note: '' }); setKey(newKey()); onDone()
    } catch (err) { setMsg({ bad: err.message + ' - you can safely press Send again.' }) }
    setBusy(false) }
  return (<form className="card" onSubmit={go}><h3>Send money</h3>
    <input required placeholder="Recipient account number (CB...)" value={f.toAccount} onChange={(e) => setF({ ...f, toAccount: e.target.value })} />
    <div className="row"><input required type="number" min="1" step="0.01" placeholder="Amount (₹)" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      <input placeholder="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
    <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
    {msg && <div className={msg.ok ? 'ok' : 'bad'} style={{ marginTop: 8 }}>{msg.ok || msg.bad}</div>}</form>)
}

function History({ txs }) {
  return (<div className="card"><h3>Transaction history</h3><table><thead><tr><th>Date</th><th>Type</th><th>Counterparty</th><th>Amount</th></tr></thead><tbody>
    {txs.map((t) => (<tr key={t.txId}><td>{when(t.createdAt)}</td><td>{t.type}</td><td>{t.counterparty}</td>
      <td className={t.direction === 'DEBIT' ? 'debit' : 'credit'}>{t.direction === 'DEBIT' ? '−' : '+'}{inr(t.amount)}</td></tr>))}
    {!txs.length && <tr><td colSpan="4" className="muted">No transactions yet</td></tr>}</tbody></table></div>)
}

function Statements({ list, reload }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)), [msg, setMsg] = useState('')
  const gen = async () => { try { await api('/statements', { method: 'POST', body: { month } }); setMsg('Requested - the PDF is generated in the background.'); reload() } catch (e) { setMsg(e.message) } }
  const dl = async (id) => { try { const r = await api(`/statements/${id}/download`); window.open(r.url, '_blank') } catch (e) { setMsg(e.message) } }
  return (<div className="card"><h3>Statements (PDF)</h3><div className="row"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
    <button className="btn" onClick={gen}>Generate statement</button></div>{msg && <p className="muted">{msg}</p>}
    <table><tbody>{list.map((s) => (<tr key={s.id}><td>{s.month}</td><td>{s.status}</td>
      <td>{s.status === 'READY' && <button className="btn alt" onClick={() => dl(s.id)}>Download</button>}</td></tr>))}</tbody></table>
    <p className="muted">Files are private; each download uses a link that expires in 10 minutes.</p></div>)
}

function Standing({ list, reload }) {
  const [f, setF] = useState({ toAccount: '', amount: '', intervalDays: 30 }), [msg, setMsg] = useState('')
  const add = async (e) => { e.preventDefault(); try { await api('/standing-orders', { method: 'POST', body: { ...f, intervalDays: Number(f.intervalDays) } }); setMsg('Created - runs at the next scheduler tick (daily 09:00 IST).'); reload() } catch (x) { setMsg(x.message) } }
  const del = async (id) => { await api(`/standing-orders/${id}`, { method: 'DELETE' }); reload() }
  return (<div className="card"><h3>Recurring payments</h3><form onSubmit={add} className="row">
    <input required placeholder="Recipient account" value={f.toAccount} onChange={(e) => setF({ ...f, toAccount: e.target.value })} />
    <input required type="number" min="1" step="0.01" placeholder="Amount (₹)" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
    <select value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: e.target.value })}><option value="1">Daily</option><option value="7">Weekly</option><option value="30">Monthly</option></select>
    <button className="btn">Add</button></form>{msg && <p className="muted">{msg}</p>}
    <table><tbody>{list.map((o) => (<tr key={o.id}><td>{o.toAccount}</td><td>{inr(o.amount)}</td><td>every {o.intervalDays}d</td><td className="muted">{o.lastStatus || 'pending'}</td>
      <td><button className="btn red" onClick={() => del(o.id)}>Cancel</button></td></tr>))}</tbody></table></div>)
}

function Admin() {
  const [stats, setStats] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [users, setUsers] = useState([]), [usersLoading, setUsersLoading] = useState(true), [usersError, setUsersError] = useState('')
  const [nextPageToken, setNextPageToken] = useState(null), [busyUid, setBusyUid] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try { setStats(await api('/admin/stats')) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [])
  const loadUsers = useCallback(async (pageToken, append = false) => {
    setUsersLoading(true); setUsersError('')
    try {
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
      const page = await api(`/admin/users${query}`)
      setUsers((current) => append ? [...current, ...page.users] : page.users)
      setNextPageToken(page.nextPageToken)
    } catch (err) { setUsersError(err.message) }
    finally { setUsersLoading(false) }
  }, [])
  useEffect(() => { refresh(); loadUsers() }, [refresh, loadUsers])
  const setUserRole = async (user) => {
    const role = user.role === 'admin' ? 'customer' : 'admin'
    const action = role === 'admin' ? 'grant administrator access to' : 'remove administrator access from'
    if (!window.confirm(`Are you sure you want to ${action} ${user.email || user.uid}? They must sign out and back in for the change to take effect.`)) return
    setBusyUid(user.uid); setUsersError('')
    try {
      await api(`/admin/users/${encodeURIComponent(user.uid)}/role`, { method: 'PATCH', body: { role } })
      setUsers((current) => current.map((item) => item.uid === user.uid ? { ...item, role } : item))
    } catch (err) { setUsersError(err.message) }
    finally { setBusyUid('') }
  }
  const dashboardUrl = import.meta.env.VITE_LOOKER_STUDIO_URL?.trim()
  const safeDashboardUrl = dashboardUrl?.startsWith('https://') ? dashboardUrl : ''
  return (<>
    <section className="card report-card"><div><span className="eyebrow">ADMINISTRATOR</span><h2>Audit and reporting</h2>
      <p className="muted">Explore transaction audit data streamed to BigQuery.</p></div>
      {safeDashboardUrl ? <a className="btn report-link" href={safeDashboardUrl} target="_blank" rel="noopener noreferrer">Open Looker Studio <span aria-hidden="true">↗</span></a>
        : <p className="report-setup">Dashboard link not configured. Create a Looker Studio report connected to <b>cloudbank_audit.transactions_audit</b>, then set <code>VITE_LOOKER_STUDIO_URL</code> in <code>frontend/.env</code> and rebuild.</p>}
    </section>
    <section className="card"><div className="admin-title"><h3>Platform overview</h3><button className="btn" onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      {error && <div className="bad" role="alert">{error}</div>}
      {loading && !stats ? <p className="muted">Loading platform metrics…</p> : stats && <>
        <p><b>{stats.accounts}</b> accounts · <b>{stats.transactions}</b> transactions</p>
        <div className="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>From → To</th><th>Amount</th></tr></thead><tbody>
          {stats.recent.map((t) => (<tr key={t.txId}><td>{when(t.createdAt)}</td><td>{t.type}</td><td>{t.from} → {t.to}</td><td>{inr(t.amount)}</td></tr>))}
          {!stats.recent.length && <tr><td colSpan="4" className="muted">No transactions yet</td></tr>}
        </tbody></table></div>
      </>}
    </section>
    <section className="card"><div className="admin-title"><div><h3>User and role management</h3>
      <p className="muted">Administrator role changes take effect after the user signs out and back in.</p></div>
      <button className="btn" onClick={() => loadUsers()} disabled={usersLoading}>{usersLoading ? 'Loading…' : 'Refresh users'}</button></div>
      {usersError && <div className="bad" role="alert">{usersError}</div>}
      <div className="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>
        {users.map((user) => <tr key={user.uid}><td>{user.displayName || user.email || user.uid}</td><td>{user.role}</td>
          <td>{user.disabled ? 'Disabled' : 'Active'}</td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</td>
          <td><button className={`btn ${user.role === 'admin' ? 'red' : ''}`} disabled={busyUid === user.uid || user.uid === auth.currentUser?.uid || usersLoading}
            onClick={() => setUserRole(user)}>{busyUid === user.uid ? 'Saving…' : user.role === 'admin' ? 'Remove admin' : 'Make admin'}</button></td></tr>)}
        {!users.length && !usersLoading && !usersError && <tr><td colSpan="5" className="muted">No users found.</td></tr>}
      </tbody></table></div>
      {nextPageToken && <button className="btn" onClick={() => loadUsers(nextPageToken, true)} disabled={usersLoading}>{usersLoading ? 'Loading…' : 'Load more users'}</button>}
    </section>
  </>)
}

function Dashboard({ user }) {
  const [tab, setTab] = useState('home'), [acc, setAcc] = useState(null), [txs, setTxs] = useState([]), [notes, setNotes] = useState([])
  const [stmts, setStmts] = useState([]), [orders, setOrders] = useState([]), [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('')
  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [a, t, n, s, o] = await Promise.all([api('/account'), api('/transactions'), api('/notifications'), api('/statements'), api('/standing-orders')])
      setAcc(a); setTxs(t); setNotes(n); setStmts(s); setOrders(o)
    } catch (e) { setLoadError(e.message) }
    finally { setLoading(false) }
  }, [])
  const initializeAccount = async () => {
    setLoading(true); setLoadError('')
    try {
      await api('/account/init', { method: 'POST', body: { name: user.displayName || (user.email || 'user').split('@')[0] } })
      await user.getIdToken(true)
      await load()
    } catch (e) { setLoadError(e.message); setLoading(false) }
  }
  useEffect(() => { user.getIdTokenResult().then((r) => setIsAdmin(r.claims.role === 'admin')); load(); const i = setInterval(load, 7000); return () => clearInterval(i) }, [user, load])
  const tabs = [['home', 'Home'], ['history', 'History'], ['statements', 'Statements'], ['recurring', 'Recurring'], ...(isAdmin ? [['admin', 'Admin']] : [])]
  return (<><nav><b>🏦 Cloud Bank</b>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
    <button onClick={() => signOut(auth)}>Log out</button></nav><main className="dashboard-main">
    {loadError && <div className="bad dashboard-alert" role="alert"><span>{loadError}</span><button className="btn" onClick={load}>Try again</button></div>}
    {tab === 'home' && (acc ? <><section className="dashboard-heading"><div><span className="eyebrow">YOUR DASHBOARD</span><h1>Good to see you, {acc.ownerName}.</h1>
      <p>Here’s a snapshot of your Cloud Bank account.</p></div><span className="account-status"><span /> Account active</span></section>
      <div className="card balance-card"><div><div className="muted">AVAILABLE BALANCE</div><div className="bal">{inr(acc.balance)}</div>
        <div className="muted">Account number <b>{acc.accountNumber}</b></div></div><div className="balance-symbol" aria-hidden="true">₹</div></div>
      <Transfer onDone={load} /><div className="row"><Money title="Deposit" path="/deposit" onDone={load} /><Money title="Withdraw" path="/withdraw" onDone={load} /></div>
      <div className="card"><h3>Notifications</h3>{notes.map((n) => <p key={n.id}>🔔 {n.message} <span className="muted">· {when(n.createdAt)}</span></p>)}{!notes.length && <p className="muted">Nothing yet</p>}</div></>
      : <section className="card dashboard-welcome"><span className="welcome-icon">C</span><h1>{loading ? 'Preparing your dashboard…' : 'Your account overview'}</h1>
        <p>{loading ? 'We’re securely loading your account details.' : 'We couldn’t load your account information just now. Check your connection and try again.'}</p>
        {!loading && <button className="btn" onClick={loadError.toLowerCase().includes('account not initialised') ? initializeAccount : load}>
          {loadError.toLowerCase().includes('account not initialised') ? 'Finish account setup' : 'Retry loading account'}</button>}</section>)}
    {tab === 'history' && <History txs={txs} />}{tab === 'statements' && <Statements list={stmts} reload={load} />}
    {tab === 'recurring' && <Standing list={orders} reload={load} />}{tab === 'admin' && isAdmin && <Admin />}</main></>)
}

export default function App() {
  const [user, setUser] = useState(undefined)
  useEffect(() => onAuthStateChanged(auth, setUser), [])
  if (user === undefined) return <p style={{ padding: 30 }}>Loading…</p>
  return user ? <Dashboard user={user} /> : <Login />
}
