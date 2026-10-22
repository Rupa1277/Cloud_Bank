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
  return (<div className="card login"><h2>🏦 Cloud Bank</h2><p className="muted">Secure. Scalable. Serverless.</p>
    <form onSubmit={submit}>
      {mode === 'signup' && <input required placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
      <input required type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input required type="password" minLength={6} placeholder="Password (min 6)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <button className="btn" style={{ width: '100%' }}>{mode === 'signup' ? 'Create account' : 'Log in'}</button></form>
    {msg && <div className="bad" style={{ marginTop: 10 }}>{msg}</div>}
    <p className="muted" style={{ cursor: 'pointer' }} onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
      {mode === 'login' ? 'New here? Sign up' : 'Have an account? Log in'}</p></div>)
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
  const [s, setS] = useState(null)
  useEffect(() => { api('/admin/stats').then(setS).catch(() => {}) }, [])
  return (<div className="card"><h3>Admin overview</h3>{s ? (<><p><b>{s.accounts}</b> accounts · <b>{s.transactions}</b> transactions</p>
    <table><tbody>{s.recent.map((t) => (<tr key={t.txId}><td>{when(t.createdAt)}</td><td>{t.type}</td><td>{t.from} → {t.to}</td><td>{inr(t.amount)}</td></tr>))}</tbody></table>
    <p className="muted">Full analytics: open the Looker Studio dashboard connected to BigQuery (see README).</p></>) : 'Loading…'}</div>)
}

function Dashboard({ user }) {
  const [tab, setTab] = useState('home'), [acc, setAcc] = useState(null), [txs, setTxs] = useState([]), [notes, setNotes] = useState([])
  const [stmts, setStmts] = useState([]), [orders, setOrders] = useState([]), [isAdmin, setIsAdmin] = useState(false)
  const load = useCallback(async () => {
    try {
      const [a, t, n, s, o] = await Promise.all([api('/account'), api('/transactions'), api('/notifications'), api('/statements'), api('/standing-orders')])
      setAcc(a); setTxs(t); setNotes(n); setStmts(s); setOrders(o)
    } catch (e) { console.error(e) }
  }, [])
  useEffect(() => { user.getIdTokenResult().then((r) => setIsAdmin(r.claims.role === 'admin')); load(); const i = setInterval(load, 7000); return () => clearInterval(i) }, [user, load])
  const tabs = [['home', 'Home'], ['history', 'History'], ['statements', 'Statements'], ['recurring', 'Recurring'], ...(isAdmin ? [['admin', 'Admin']] : [])]
  return (<><nav><b>🏦 Cloud Bank</b>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
    <button onClick={() => signOut(auth)}>Log out</button></nav><main>
    {acc && tab === 'home' && (<><div className="card"><div className="muted">Hello, {acc.ownerName} · {isAdmin ? 'Administrator' : 'Retail customer'}</div>
      <div className="bal">{inr(acc.balance)}</div><div className="muted">Account number: <b>{acc.accountNumber}</b></div></div>
      <Transfer onDone={load} /><div className="row"><Money title="Deposit" path="/deposit" onDone={load} /><Money title="Withdraw" path="/withdraw" onDone={load} /></div>
      <div className="card"><h3>Notifications</h3>{notes.map((n) => <p key={n.id}>🔔 {n.message} <span className="muted">· {when(n.createdAt)}</span></p>)}{!notes.length && <p className="muted">Nothing yet</p>}</div></>)}
    {tab === 'history' && <History txs={txs} />}{tab === 'statements' && <Statements list={stmts} reload={load} />}
    {tab === 'recurring' && <Standing list={orders} reload={load} />}{tab === 'admin' && isAdmin && <Admin />}</main></>)
}

export default function App() {
  const [user, setUser] = useState(undefined)
  useEffect(() => onAuthStateChanged(auth, setUser), [])
  if (user === undefined) return <p style={{ padding: 30 }}>Loading…</p>
  return user ? <Dashboard user={user} /> : <Login />
}
