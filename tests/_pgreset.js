'use strict';
// When DATABASE_URL is set, wipe the schema so each test run starts clean on a real Postgres.
module.exports = async function resetIfPg() {
  if (!process.env.DATABASE_URL) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
};
