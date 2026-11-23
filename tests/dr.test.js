'use strict';
// Disaster-recovery drill (embedded database): snapshot a live system, restore into a fresh directory, prove integrity.
process.env.DATABASE_DIR = 'memory://'; process.env.NODE_ENV = 'test'; process.env.QUIET_SMS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const db = require('../src/db');
const seed = require('../src/seed');
const ledger = require('../src/ledger');
const security = require('../src/security');
const { backupLite, restoreLite } = require('../scripts/backup');

test('snapshot → restore into a new database → ledger reconciles and audit chain verifies', async (t) => {
  if (process.env.DATABASE_URL) return t.skip('embedded-engine drill; for Postgres use scripts/backup.js with pg_dump');
  await seed.run({ demo: true });
  const before = await db.tx(async (c) => ({ r: await ledger.reconcile(c), a: await security.verifyAudit(c), users: (await c.one('SELECT COUNT(*)::int n FROM users')).n, mk: (await c.one('SELECT COUNT(*)::int n FROM markets')).n }));
  assert.ok(before.r.ok && before.a.ok);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictable-dr-')); const file = path.join(dir, 'snap.tgz');
  await backupLite(db, file); assert.ok(fs.statSync(file).size > 1000);
  await db.close();
  await restoreLite(file, path.join(dir, 'restored'));
  await db.init(path.join(dir, 'restored'));
  const after = await db.tx(async (c) => ({ r: await ledger.reconcile(c), a: await security.verifyAudit(c), users: (await c.one('SELECT COUNT(*)::int n FROM users')).n, mk: (await c.one('SELECT COUNT(*)::int n FROM markets')).n }));
  assert.ok(after.r.ok, 'restored ledger reconciles'); assert.ok(after.a.ok, 'restored audit chain verifies');
  assert.equal(after.users, before.users); assert.equal(after.mk, before.mk);
  assert.equal(after.r.net_of_all_accounts_minor, 0);
  await db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
