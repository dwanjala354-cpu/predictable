-- Migration 003 — from betting marketplace to a binary prediction market.
--
-- CLEAN BREAK (pre-launch, simulated money only): all market, betting, payment and ledger rows are removed because
-- stakes/odds have no meaning in the new model. Users, roles, KYC, sessions, MFA, settings, audit log and research
-- tables are kept. Real-money data must never reach this migration; it exists to move development and demo
-- databases to the new schema.

-- ───────────── 1. Wipe and drop the betting model ─────────────
TRUNCATE markets, payment_intents, payment_events, withdrawal_requests, financial_reconciliations, notifications RESTART IDENTITY CASCADE;
UPDATE ledger_accounts SET balance_minor = 0;

DROP TRIGGER IF EXISTS trg_market_terms_locked ON markets;
DROP TRIGGER IF EXISTS trg_outcomes_locked ON market_outcomes;
DROP FUNCTION IF EXISTS protect_committed_market();
DROP FUNCTION IF EXISTS protect_committed_outcomes();

DROP TABLE IF EXISTS accumulator_legs, accumulators, payouts, refunds, escrow_allocations, commission_records,
                     odds_history, market_invitations, market_participants, bet_entries CASCADE;
DROP FUNCTION IF EXISTS assert_market_open();
DROP FUNCTION IF EXISTS assert_leg_market_open();

ALTER TABLE markets
  DROP COLUMN market_type, DROP COLUMN stake_mode, DROP COLUMN fixed_stake_minor, DROP COLUMN min_stake_minor,
  DROP COLUMN max_stake_minor, DROP COLUMN min_participants, DROP COLUMN max_participants, DROP COLUMN distribution,
  DROP COLUMN max_liability_minor, DROP COLUMN max_payout_minor;
ALTER TABLE market_outcomes DROP COLUMN odds_milli;

-- ───────────── 2. Binary contract market ─────────────
-- A market has exactly two outcomes (YES / NO). One contract pays KES 100 if it wins and KES 0 if it loses, so
-- price(YES) + price(NO) = 100 and a price of KES 1–99 is the market's probability in percent.
ALTER TABLE markets
  ADD COLUMN initial_price_kes  smallint NOT NULL DEFAULT 50 CHECK (initial_price_kes BETWEEN 1 AND 99),
  ADD COLUMN yes_price_kes      numeric(6,2) NOT NULL DEFAULT 50 CHECK (yes_price_kes BETWEEN 1 AND 99),
  ADD COLUMN no_price_kes       numeric(6,2) NOT NULL DEFAULT 50 CHECK (no_price_kes BETWEEN 1 AND 99),
  ADD COLUMN last_trade_kes     smallint CHECK (last_trade_kes BETWEEN 1 AND 99),
  ADD COLUMN volume_minor       bigint NOT NULL DEFAULT 0,
  ADD COLUMN trade_count        int    NOT NULL DEFAULT 0,
  ADD CONSTRAINT yes_no_sum_100 CHECK (yes_price_kes + no_price_kes = 100);

ALTER TABLE users ADD COLUMN market_creator boolean NOT NULL DEFAULT false;   -- "approved user": may propose markets (staff always may)

-- ───────────── 3. Ledger accounts ─────────────
DELETE FROM ledger_accounts WHERE account_type IN ('RESERVED_P2P','RESERVED_HOUSE','SYS_HOUSE_BANK','SYS_P2P_COMMISSION');   -- all zero: ledger was wiped above
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_account_type_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_account_type_check CHECK (account_type IN (
  'AVAILABLE','RESERVED_ORDERS','PENDING_WITHDRAWAL',
  'SYS_FUNDING','SYS_WITHDRAWAL_CLEARING','SYS_ESCROW','SYS_KRA_TAX_PAYABLE','SYS_KRA_REMITTED','SYS_PLATFORM_REVENUE','SYS_AMM_FUND'));

INSERT INTO ledger_accounts(wallet_id, account_type) SELECT id, 'RESERVED_ORDERS' FROM wallets;
ALTER TABLE ledger_transactions
  ADD COLUMN gross_minor bigint, ADD COLUMN tax_minor bigint, ADD COLUMN fee_minor bigint, ADD COLUMN net_minor bigint;
ALTER TABLE payment_intents ADD COLUMN excise_minor bigint, ADD COLUMN fee_minor bigint, ADD COLUMN net_minor bigint;
ALTER TABLE withdrawal_requests ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0, ADD COLUMN fee_minor bigint NOT NULL DEFAULT 0, ADD COLUMN net_minor bigint;

-- ───────────── 4. Orders, trades, positions ─────────────
-- Every order is expressed on ONE book of YES prices. BID side: BUY YES, or SELL NO (same thing, mirrored).
-- ASK side: SELL YES, or BUY NO. `price_kes` is always the YES price; `limit_kes` is the price in the order's own asset.
CREATE TABLE orders (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id      bigint NOT NULL REFERENCES markets(id),
  user_id        bigint NOT NULL REFERENCES users(id),
  action         text NOT NULL CHECK (action IN ('BUY','SELL')),
  asset          text NOT NULL CHECK (asset IN ('YES','NO')),
  book_side      text NOT NULL CHECK (book_side IN ('BID','ASK')),
  price_kes      smallint NOT NULL CHECK (price_kes BETWEEN 1 AND 99),
  limit_kes      smallint NOT NULL CHECK (limit_kes BETWEEN 1 AND 99),
  qty            bigint NOT NULL CHECK (qty > 0),
  filled         bigint NOT NULL DEFAULT 0,
  tif            text NOT NULL DEFAULT 'GTC' CHECK (tif IN ('GTC','IOC')),
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED','CANCELLED')),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),          -- cash still held for the unfilled part (BUY)
  cancel_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (filled >= 0 AND filled <= qty),
  CHECK ((action='BUY' AND asset='YES' AND book_side='BID') OR (action='SELL' AND asset='NO'  AND book_side='BID')
      OR (action='SELL' AND asset='YES' AND book_side='ASK') OR (action='BUY'  AND asset='NO'  AND book_side='ASK')),
  CHECK ((asset='YES' AND limit_kes = price_kes) OR (asset='NO' AND limit_kes = 100 - price_kes))
);
CREATE INDEX idx_orders_book ON orders(market_id, book_side, price_kes, id) WHERE status = 'OPEN';
CREATE INDEX idx_orders_user ON orders(user_id, id DESC);

CREATE TABLE trades (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id     bigint NOT NULL REFERENCES markets(id),
  kind          text NOT NULL CHECK (kind IN ('TRANSFER_YES','TRANSFER_NO','MINT','MERGE','AMM_BUY_YES','AMM_BUY_NO','AMM_SELL_YES','AMM_SELL_NO')),
  price_kes     smallint NOT NULL CHECK (price_kes BETWEEN 1 AND 99),            -- YES-equivalent price (AMM trades: average, rounded)
  qty           bigint NOT NULL CHECK (qty > 0),
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),                       -- cash that changed hands, before tax/commission
  bid_order_id  bigint REFERENCES orders(id),
  ask_order_id  bigint REFERENCES orders(id),
  taker_order_id bigint REFERENCES orders(id),
  bid_user_id   bigint REFERENCES users(id),
  ask_user_id   bigint REFERENCES users(id),
  ledger_reference text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trades_market ON trades(market_id, id);

CREATE TABLE positions (
  market_id        bigint NOT NULL REFERENCES markets(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  yes_shares       bigint NOT NULL DEFAULT 0 CHECK (yes_shares >= 0),
  no_shares        bigint NOT NULL DEFAULT 0 CHECK (no_shares >= 0),
  yes_locked       bigint NOT NULL DEFAULT 0 CHECK (yes_locked >= 0),            -- shares committed to resting sell orders
  no_locked        bigint NOT NULL DEFAULT 0 CHECK (no_locked >= 0),
  yes_cost_minor   bigint NOT NULL DEFAULT 0 CHECK (yes_cost_minor >= 0),        -- cost basis of shares still held
  no_cost_minor    bigint NOT NULL DEFAULT 0 CHECK (no_cost_minor >= 0),
  realized_pnl_minor bigint NOT NULL DEFAULT 0,                                  -- after tax and commission
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, user_id),
  CHECK (yes_locked <= yes_shares AND no_locked <= no_shares)
);
CREATE INDEX idx_positions_user ON positions(user_id);

-- Collateral: every minted YES+NO pair locks KES 100 here, per market. Invariant (checked by tests and by the
-- finance console): SYS_ESCROW balance = Σ locked_minor = 10,000 minor units × outstanding YES shares = same for NO.
CREATE TABLE escrow_pools (
  market_id    bigint PRIMARY KEY REFERENCES markets(id),
  locked_minor bigint NOT NULL DEFAULT 0 CHECK (locked_minor >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Optional platform-funded automatic market maker (constant product). The platform carries bounded risk: at most
-- `subsidy_minor` per market. Reserves are in minor units of payout (1 unit pays 1 minor if its side wins).
CREATE TABLE amm_pools (
  market_id     bigint PRIMARY KEY REFERENCES markets(id),
  subsidy_minor bigint NOT NULL CHECK (subsidy_minor > 0),
  r_yes         bigint NOT NULL CHECK (r_yes > 0),
  r_no          bigint NOT NULL CHECK (r_no > 0),
  held_yes      bigint NOT NULL DEFAULT 0 CHECK (held_yes >= 0),                 -- leftover tokens from seeding at a prior ≠ 50%
  held_no       bigint NOT NULL DEFAULT 0 CHECK (held_no >= 0),
  enabled       boolean NOT NULL DEFAULT true,
  returned_minor bigint,                                                          -- set at settlement
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Only OPEN markets accept orders or trades.
CREATE FUNCTION assert_market_trading() RETURNS trigger AS $$
DECLARE m markets%ROWTYPE;
BEGIN
  SELECT * INTO m FROM markets WHERE id = NEW.market_id;
  IF m.status <> 'OPEN' THEN RAISE EXCEPTION 'Market % is not open for trading (status %)', m.id, m.status; END IF;
  IF m.closes_at <= now() THEN RAISE EXCEPTION 'Market % closed at %', m.id, m.closes_at; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_requires_open_market BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION assert_market_trading();
CREATE TRIGGER trg_trade_requires_open_market BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION assert_market_trading();

-- Once anyone holds a contract the question and its dates cannot change.
CREATE FUNCTION protect_committed_market() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trades WHERE market_id = OLD.id) AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.event_at IS DISTINCT FROM OLD.event_at OR NEW.initial_price_kes IS DISTINCT FROM OLD.initial_price_kes) THEN
    RAISE EXCEPTION 'Market % has committed funds: its terms can no longer be changed', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_market_terms_locked BEFORE UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION protect_committed_market();

CREATE FUNCTION protect_committed_outcomes() RETURNS trigger AS $$
DECLARE mid bigint := COALESCE(OLD.market_id, NEW.market_id);
BEGIN
  IF EXISTS (SELECT 1 FROM trades WHERE market_id = mid) THEN
    RAISE EXCEPTION 'Outcomes of market % are locked: funds are committed', mid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_outcomes_locked BEFORE INSERT OR UPDATE OR DELETE ON market_outcomes FOR EACH ROW EXECUTE FUNCTION protect_committed_outcomes();

-- ───────────── 5. Tax and platform-revenue records ─────────────
-- One row per tax deduction. `kra_remittance_status` tracks whether the money held in SYS_KRA_TAX_PAYABLE has been paid on.
CREATE TABLE tax_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_type              text NOT NULL CHECK (tax_type IN ('DEPOSIT_EXCISE','WITHDRAWAL_WHT','WINNINGS_WHT','EXIT_WHT')),
  user_id               bigint NOT NULL REFERENCES users(id),
  market_id             bigint REFERENCES markets(id),
  base_minor            bigint NOT NULL,                 -- amount the rate was applied to
  rate_bps              int NOT NULL,
  amount_minor          bigint NOT NULL,                 -- negative = credit note from a reversed settlement
  ledger_reference      text NOT NULL,
  period                text NOT NULL,                   -- YYYY-MM (Africa/Nairobi calendar month)
  kra_remittance_status text NOT NULL DEFAULT 'PENDING' CHECK (kra_remittance_status IN ('PENDING','REMITTED')),
  receipt_ref           text,
  remitted_by           bigint REFERENCES users(id),
  remitted_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (kra_remittance_status = 'PENDING' OR (receipt_ref IS NOT NULL AND remitted_at IS NOT NULL))
);
CREATE INDEX idx_tax_status ON tax_events(kra_remittance_status, period);

CREATE TABLE revenue_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('DEPOSIT_FEE','WITHDRAWAL_FEE','PROFIT_COMMISSION')),
  user_id          bigint NOT NULL REFERENCES users(id),
  market_id        bigint REFERENCES markets(id),
  amount_minor     bigint NOT NULL,                      -- negative = credit note
  ledger_reference text NOT NULL,
  period           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kra_remittances (                           -- one row per batch the finance team pays on
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_ref   text UNIQUE NOT NULL,
  period        text,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  events        int NOT NULL,
  remitted_by   bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 6. Settlement payouts (per user per side) ─────────────
CREATE TABLE payouts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id    bigint NOT NULL REFERENCES settlements(id),
  market_id        bigint NOT NULL REFERENCES markets(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  side             text NOT NULL CHECK (side IN ('YES','NO')),
  shares           bigint NOT NULL CHECK (shares > 0),
  gross_minor      bigint NOT NULL CHECK (gross_minor >= 0),    -- shares × KES 100 for winners; value at last price for voids
  cost_basis_minor bigint NOT NULL,
  profit_minor     bigint NOT NULL,                              -- gross − cost basis, never below zero for tax
  wht_minor        bigint NOT NULL DEFAULT 0,
  commission_minor bigint NOT NULL DEFAULT 0,
  net_minor        bigint NOT NULL,
  status           text NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','REVERSED')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payouts_user ON payouts(user_id);
