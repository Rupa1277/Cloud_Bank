// Demo helper: signs in with Firebase, then asks the protected admin endpoint
// to make three real ledger transfers using simulated Cloud Bank balances.
// The default INR 50,000 amount demonstrates the high-value signal and the
// serial third transfer demonstrates velocity; DEMO_AMOUNT_INR can override it.
const { randomUUID } = require('node:crypto');

const required = ['CLOUDBANK_BASE_URL', 'FIREBASE_API_KEY', 'DEMO_EMAIL', 'DEMO_PASSWORD', 'DEMO_RECIPIENT_ACCOUNT'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const baseUrl = process.env.CLOUDBANK_BASE_URL.replace(/\/+$/, '');
const parsedBaseUrl = new URL(baseUrl);
if (!['https:', 'http:'].includes(parsedBaseUrl.protocol)) {
  console.error('CLOUDBANK_BASE_URL must use HTTPS (HTTP is allowed for local testing).');
  process.exit(1);
}
const simulationKey = process.env.DEMO_IDEMPOTENCY_KEY || `fraud-demo-${randomUUID()}`;
if (!/^[A-Za-z0-9_-]{8,100}$/.test(simulationKey)) {
  console.error('DEMO_IDEMPOTENCY_KEY must contain 8-100 letters, numbers, underscores, or hyphens.');
  process.exit(1);
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

async function main() {
  console.log(`Simulation idempotency key: ${simulationKey}`);
  const loginResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DEMO_EMAIL,
        password: process.env.DEMO_PASSWORD,
        returnSecureToken: true,
      }),
    },
  );
  const session = await readJson(loginResponse);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.idToken}`,
    'Idempotency-Key': simulationKey,
  };

  const amount = process.env.DEMO_AMOUNT_INR;
  const response = await fetch(`${baseUrl}/api/demo/simulate-fraud`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      recipientAccount: process.env.DEMO_RECIPIENT_ACCOUNT,
      ...(amount ? { amount } : {}),
    }),
  });
  const result = await readJson(response);

  console.log(result.note);
  for (const [index, transfer] of result.transfers.entries()) {
    console.log(
      `${index + 1}. ${transfer.status}${transfer.duplicate ? ' (idempotent replay)' : ''} | ` +
      `tx ${transfer.txId} | ₹${(transfer.amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} | ` +
      `risk ${transfer.risk?.level || 'N/A'} ${transfer.risk?.score ?? 0}/100`,
    );
    for (const reason of transfer.risk?.reasons || []) console.log(`   - ${reason}`);
  }
}

main().catch((error) => {
  console.error(`Fraud simulation failed: ${error.message}`);
  process.exitCode = 1;
});
