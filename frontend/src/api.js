import { auth } from './firebase'
// Every call carries a fresh Firebase JWT. Money-moving calls also carry an Idempotency-Key.
export async function api(path, { method = 'GET', body, idem } = {}) {
  const token = await auth.currentUser.getIdToken()
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}
export const inr = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const when = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
