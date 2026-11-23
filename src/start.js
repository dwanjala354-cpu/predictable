'use strict';
const db = require('./db');
const seed = require('./seed');
const markets = require('./markets');
const { createApp } = require('./server');

(async () => {
  const demo = process.env.PREDICTABLE_DEMO !== '0';
  await seed.run({ demo });
  const app = createApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`PREDICTABLE (stage two, SIMULATED FUNDS) → http://localhost:${port}`);
    console.log(`  App /  (also /app)      Admin /admin`);
    console.log(`  Demo logins (password "${seed.STAFF_PASSWORD}"): dennis, brian, amina, wanjiku, otieno | staff: superadmin, admin, moderator, settle1, settle2, finance, risk`);
  });
  // Time-driven lifecycle: open scheduled markets, lock at the deadline, move to event-pending.
  setInterval(() => db.tx((c) => markets.tick(c)).catch((e) => console.error('[tick]', e.message)), 15000);
})().catch((e) => { console.error(e); process.exit(1); });
