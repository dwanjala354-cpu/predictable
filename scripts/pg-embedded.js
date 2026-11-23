'use strict';
// Starts a throwaway real PostgreSQL server for tests (embedded binaries). Postgres refuses to run as root,
// so on a root shell run:  runuser -u <non-root-user> -- node scripts/pg-embedded.js
// Prints "READY <url>" when accepting connections; stops on SIGINT/SIGTERM.
const EmbeddedPostgres = require('embedded-postgres').default;
const os = require('os'); const path = require('path'); const fs = require('fs');
const port = parseInt(process.env.PGPORT || '54330', 10);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predictable-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise(); await pg.start();
  await pg.createDatabase('predictable_test');
  console.log(`READY postgres://postgres:pw@localhost:${port}/predictable_test`);
  const stop = async () => { try { await pg.stop(); } catch (e) {} fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch((e) => { console.error('PGFAIL', e.message); process.exit(1); });
