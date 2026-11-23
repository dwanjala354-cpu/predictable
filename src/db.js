'use strict';
// Database layer with two interchangeable backends behind one interface:
//   • DATABASE_URL set  → PostgreSQL via `pg` (production path; true concurrent connections, row locks)
//   • otherwise         → embedded Postgres (PGlite) for zero-setup development. Single connection, so
//                         transactions are serialised through a mutex. DATABASE_DIR=memory:// is ephemeral.
// Services only use: init(), tx(fn(client)), q(), one(), close(). client = { q(sql,params)→rows, one(), raw }.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
let backend = null;      // 'pg' | 'pglite'
let pool = null;         // pg.Pool
let lite = null;         // PGlite instance
let chain = Promise.resolve();
const BIGINT = 20;

async function runMigrations(execSql, querySql) {
  await execSql('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const applied = new Set((await querySql('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    await execSql(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await querySql('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    ran++;
  }
  return ran;
}

async function init(dataDir) {
  if (process.env.DATABASE_URL && !dataDir) {
    backend = 'pg';
    const { Pool, types } = require('pg');
    types.setTypeParser(BIGINT, (v) => parseInt(v, 10));      // int8 → JS number (KES minor units stay far below 2^53)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: parseInt(process.env.DB_POOL_MAX || '20', 10) });
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(727001)');        // one process migrates at a time
      const ran = await runMigrations((s) => c.query(s), async (s, p) => (await c.query(s, p)).rows);
      await c.query('SELECT pg_advisory_unlock(727001)');
      return { backend, migrationsApplied: ran };
    } finally { c.release(); }
  }
  backend = 'pglite';
  const { PGlite } = require('@electric-sql/pglite');
  const dir = dataDir || process.env.DATABASE_DIR || path.join(__dirname, '..', 'data', 'pgdata');
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  lite = new PGlite(dir, { parsers: { [BIGINT]: (v) => parseInt(v, 10) } });
  await lite.waitReady;
  const ran = await runMigrations((s) => lite.exec(s), async (s, p) => (await lite.query(s, p)).rows);
  return { backend, migrationsApplied: ran };
}

const wrap = (query, raw) => ({
  raw,
  async q(sql, params = []) { return (await query(sql, params)).rows; },
  async one(sql, params = []) { return (await query(sql, params)).rows[0] || null; },
});

// Run fn(client) inside one transaction. Retries on deadlock / serialization failure (pg only).
async function tx(fn) {
  if (backend === 'pg') {
    for (let attempt = 0; ; attempt++) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap((s, p) => c.query(s, p), c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        if ((e.code === '40P01' || e.code === '40001') && attempt < 4) { await new Promise((r) => setTimeout(r, 20 * (attempt + 1))); continue; }
        throw e;
      } finally { c.release(); }
    }
  }
  const run = chain.then(() => lite.transaction(async (t) => fn(wrap((s, p) => t.query(s, p), t))));
  chain = run.catch(() => {});
  return run;
}

const q = (sql, params = []) => tx((c) => c.q(sql, params));
const one = (sql, params = []) => tx((c) => c.one(sql, params));
const kind = () => backend;

// Consistent snapshot of the whole database as a file (PGlite) — used by backup tooling and the DR test.
async function dumpLite() { return lite.dumpDataDir('gzip'); }

async function close() {
  if (pool) { await pool.end(); pool = null; }
  if (lite) { await lite.close(); lite = null; }
  backend = null; chain = Promise.resolve();
}

module.exports = { init, tx, q, one, close, kind, dumpLite };
