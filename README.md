# Predictable

A prediction-market exchange for Kenya. Every market is a Yes/No question. A **Yes contract** and a **No contract** each pay **KES 100** if they are right and KES 0 if not, so a price between **KES 1 and KES 99** is also the market's chance (KES 62 ≈ 62%). Traders can sell before the event, at a profit or a loss.
Everything runs on **simulated funds**. No real money moves and no payment provider is connected.

## How it works
- **Collateral invariant**: Yes price + No price = KES 100. Each matched pair locks KES 100 in escrow (`SYS_ESCROW`); escrow always equals 10,000 minor units × contracts outstanding on each side (`/api/admin/markets/:id/escrow`, asserted in every test).
- **Order book plus market maker**: one book priced in Yes. Matches: transfer, mint (two buyers fund a new pair), merge (two sellers release escrow). Orders fill chunk by chunk at the cheaper of the book and the optional platform-funded market maker (constant-product, BigInt maths).
- **Who can create markets**: staff and approved users (`users.market_creator`). Every market is reviewed by a different person; creators cannot trade their own market.
- **Money** is integer minor units (KES × 100). Ledger is double-entry and append-only.

## Fees and tax (all rates are settings)
| Event | Rule |
|---|---|
| Deposit | 5% excise + 5% fee, 90% credited |
| Win or profitable sale | 20% withholding tax + 10% commission on **profit only** (10 Yes at KES 40, wins: payout 1,000, profit 600, tax 120, commission 60, **net 820**). Losses are never taxed. |
| Withdrawal | 5% withholding + 5% fee, 90% paid out |
| GGR tax | 15% of monthly platform revenue, due by the 20th (tracked in Tax and revenue) |
Tax events carry `PENDING / REMITTED` status and a KRA receipt reference. Treasury accounts: user wallets, `SYS_KRA_TAX_PAYABLE`, `SYS_PLATFORM_REVENUE`.

## Run it

```
npm install
npm start            # http://localhost:3000  (data persists in ./data)
```
- `/` market app (also `/app`)  ·  `/admin` staff console
- `PREDICTABLE_DEMO=0 npm start` starts without demo data · `PORT=8080` changes the port
- Demo players: `dennis brian amina wanjiku otieno` · staff: `superadmin admin moderator settle1 settle2 finance risk`
- Password for all: `Predictable#2026` (override with `PREDICTABLE_STAFF_PASSWORD` before first start). **Change before any shared deployment.**

## Configuration
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Use a real PostgreSQL server (migrations run automatically, advisory-locked). Without it the embedded engine stores data in `./data`. |
| `PREDICTABLE_SECRET_KEY` | **Required in production.** Seals authenticator secrets at rest (AES-256-GCM). |
| `TRUST_PROXY=1` | Behind a reverse proxy, so rate limits and session records use the real client address. |
| `RATE_LIMIT_API` / `RATE_LIMIT_AUTH` / `RATE_LIMIT=off` | Request limits per client (defaults 600 / 30 per minute). |
| `SMS_MODE` | `simulated` (code appears in the player's notifications). `provider` is refused until a gateway is implemented in `src/sms.js`. |
| `PREDICTABLE_REQUIRE_STAFF_MFA`, `PREDICTABLE_REQUIRE_WITHDRAWAL_OTP` | Seed values for the matching settings (default on). |

## Test it
```
npm test              # engine (23) + security + recovery drill
node --test tests/ai.test.js
npm run test:scale    # 400-trader mint, double-reserve races, settle-once
npm run e2e           # HTTP end to end (start a server on :3100 first, see tests/e2e.http.js)
```
Engine, security and recovery tests also pass on real PostgreSQL via `DATABASE_URL`.

## Needs a decision before real money
- **Licensing**: Kenya's Gambling Control Act, 2025 and the Gambling Regulatory Authority (GRA). Prediction markets are likely treated as gambling, so a licence is required before any real-money use. Platform fees may also attract VAT (unverified).
- **Tax assumptions to confirm with finance**: whether withholding tax applies to gross profit or net; whether it applies to early sales (`tax_on_exit_sales`, default on); the statutory definition of GGR (revenue is used as a proxy).
- **Market maker is platform risk**: it contradicts "no house risk". Exposure is capped by the amount funded per market (`amm_max_subsidy_minor`) and in total (`amm_max_total_exposure_minor`); funding needs the `market.house.manage` permission. Leave it off for a pure order-book launch.
- **Fee friction**: 10% in, 10% out and 30% of profit is heavy; expect it to suppress trading and check it against competitors.
- **Void** redeems contracts at the last traded price (cost basis would be insolvent after secondary trades).
- **Payments**: real M-Pesa/Daraja integration, KYC provider, production secrets. **Hosting**: HTTPS, `PREDICTABLE_SECRET_KEY`, SMS gateway, scheduled backups.
# predictable
