// Usage (from the backend folder):  node ../scripts/set-admin.js user@example.com
// Gives a user the "admin" role via a Firebase custom claim (FR-02). The user must log out/in afterwards.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCP_PROJECT_ID });
(async () => {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: node set-admin.js <email>');
  const u = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(u.uid, { ...u.customClaims, role: 'admin' });
  console.log(`${email} is now an administrator. Ask them to sign out and back in.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
