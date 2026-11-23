'use strict';
// After a restore: recompute every balance from ledger entries and verify the audit hash chain.
//   DATABASE_URL=… node scripts/verify-restore.js      or      DATABASE_DIR=./data/restored node scripts/verify-restore.js
const db = require('../src/db');
const ledger = require('../src/ledger');
const security = require('../src/security');
(async () => {
  await db.init();
  const r = await db.tx((c) => ledger.reconcile(c));
  const a = await db.tx((c) => security.verifyAudit(c));
  console.log(JSON.stringify({ ledger_ok: r.ok, accounts: r.accounts_checked, net_minor: r.net_of_all_accounts_minor, audit_ok: a.ok, audit_sealed: a.sealed }, null, 2));
  await db.close();
  process.exit(r.ok && a.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
