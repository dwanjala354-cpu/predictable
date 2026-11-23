'use strict';
// Backup and restore.
//   Real Postgres (DATABASE_URL):  node scripts/backup.js backup  out.dump   → pg_dump (custom format)
//                                  node scripts/backup.js restore out.dump   → pg_restore into DATABASE_URL (must be an empty database)
//   Embedded dev database:         node scripts/backup.js backup  out.tgz    → consistent snapshot of the data directory
//                                  node scripts/backup.js restore out.tgz ./data/restored
// Always run `npm run verify-restore` (reconciliation + audit-chain check) after a restore before serving traffic.
const fs = require('fs');
const { spawnSync } = require('child_process');

function pgBin(name) {
  if (process.env.PG_BIN_DIR) return `${process.env.PG_BIN_DIR}/${name}`;
  try { const glob = require('path').join(require.resolve('embedded-postgres/package.json'), '..', '..', '@embedded-postgres'); const dirs = fs.readdirSync(glob); for (const d of dirs) { const p = `${glob}/${d}/native/bin/${name}`; if (fs.existsSync(p)) return p; } } catch (e) {}
  return name;                                           // fall back to PATH
}
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr ? r.stderr.toString().slice(0, 400) : r.error}`);
}
const urlParts = (u) => { const x = new URL(u); return { args: ['-h', x.hostname, '-p', x.port || '5432', '-U', decodeURIComponent(x.username), '-d', x.pathname.slice(1)], env: { PGPASSWORD: decodeURIComponent(x.password) } }; };

async function backupPg(url, file) { const { args, env } = urlParts(url); run(pgBin('pg_dump'), [...args, '--format=custom', '--no-owner', '-f', file], env); }
async function restorePg(url, file) { const { args, env } = urlParts(url); run(pgBin('pg_restore'), [...args, '--no-owner', '--exit-on-error', file], env); }

async function backupLite(db, file) { const blob = await db.dumpLite(); fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer())); }
async function restoreLite(file, dir) {
  const { PGlite } = require('@electric-sql/pglite');
  fs.mkdirSync(dir, { recursive: true });
  const p = new PGlite(dir, { loadDataDir: new Blob([fs.readFileSync(file)]) }); await p.waitReady; await p.close();
}

module.exports = { backupPg, restorePg, backupLite, restoreLite };

if (require.main === module) {
  (async () => {
    const [cmd, file, dir] = process.argv.slice(2);
    if (!['backup', 'restore'].includes(cmd) || !file) { console.error('usage: backup.js backup|restore <file> [restoreDir]'); process.exit(2); }
    if (process.env.DATABASE_URL) { cmd === 'backup' ? await backupPg(process.env.DATABASE_URL, file) : await restorePg(process.env.DATABASE_URL, file); }
    else if (cmd === 'backup') { const db = require('../src/db'); await db.init(); await backupLite(db, file); await db.close(); }
    else await restoreLite(file, dir || './data/restored');
    console.log(`${cmd} complete: ${file}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
