-- PREDICTABLE — migration 001: initial schema (PostgreSQL 14+, also runs on PGlite)
-- Money is ALWAYS integer minor units (KES cents). Decimal odds are stored as integer "milli-odds" (2.00 => 2000).
-- Rule: the markets table describes WHAT is bet on. The ledger records what happened to MONEY.

-- ───────────── Platform settings ─────────────
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- ───────────── Identity & access ─────────────
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  email         text UNIQUE NOT NULL,
  phone         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  date_of_birth date NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  kyc_status    text NOT NULL DEFAULT 'UNVERIFIED' CHECK (kyc_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  description text NOT NULL
);
CREATE TABLE permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  description text NOT NULL
);
CREATE TABLE user_roles (
  user_id bigint NOT NULL REFERENCES users(id),
  role_id bigint NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE role_permissions (
  role_id       bigint NOT NULL REFERENCES roles(id),
  permission_id bigint NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE user_sessions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  token_hash text UNIQUE NOT NULL,         -- SHA-256 of the bearer token; raw tokens are never stored
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kyc_records (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               bigint NOT NULL REFERENCES users(id),
  verification_provider text NOT NULL,
  status                text NOT NULL,
  verified_at           timestamptz,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE responsible_gambling_profiles (
  user_id                    bigint PRIMARY KEY REFERENCES users(id),
  daily_deposit_limit_minor  bigint CHECK (daily_deposit_limit_minor IS NULL OR daily_deposit_limit_minor >= 0),
  daily_loss_limit_minor     bigint CHECK (daily_loss_limit_minor IS NULL OR daily_loss_limit_minor >= 0),
  self_excluded_until        timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Markets ─────────────
CREATE TABLE categories (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL,
  slug      text UNIQUE NOT NULL,
  parent_id bigint REFERENCES categories(id)
);

CREATE TABLE markets (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creator_id         bigint NOT NULL REFERENCES users(id),
  category_id        bigint NOT NULL REFERENCES categories(id),
  market_type        text NOT NULL CHECK (market_type IN ('HOUSE','PRIVATE_P2P','PUBLIC_P2P')),
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                       'DRAFT','PENDING_REVIEW','APPROVED','OPEN','LOCKED','EVENT_PENDING','RESULT_PENDING','SETTLED',
                       'REJECTED','CANCELLED','VOID','DISPUTED','SUSPENDED')),
  stake_mode         text NOT NULL DEFAULT 'FIXED' CHECK (stake_mode IN ('FIXED','VARIABLE')),
  fixed_stake_minor  bigint CHECK (fixed_stake_minor IS NULL OR fixed_stake_minor > 0),
  min_stake_minor    bigint NOT NULL CHECK (min_stake_minor > 0),
  max_stake_minor    bigint NOT NULL,
  min_participants   int    NOT NULL DEFAULT 2 CHECK (min_participants >= 1),
  max_participants   int,
  distribution       text CHECK (distribution IN ('EQUAL','PROPORTIONAL')),   -- P2P only
  max_liability_minor bigint,                                                  -- HOUSE only
  max_payout_minor    bigint,                                                  -- HOUSE only
  opens_at           timestamptz,
  closes_at          timestamptz NOT NULL,                                     -- participation deadline
  event_at           timestamptz NOT NULL,
  dispute_window_hours int NOT NULL DEFAULT 24,
  version            int NOT NULL DEFAULT 1,
  suspended_from     text,                                                     -- status to restore after SUSPENDED
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (max_stake_minor >= min_stake_minor),
  CHECK (closes_at <= event_at),
  CHECK (market_type = 'HOUSE' OR distribution IS NOT NULL),
  CHECK (stake_mode = 'VARIABLE' OR fixed_stake_minor IS NOT NULL)
);

CREATE TABLE market_outcomes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id    bigint NOT NULL REFERENCES markets(id),
  outcome_name text NOT NULL,
  outcome_code text NOT NULL,
  odds_milli   int CHECK (odds_milli IS NULL OR odds_milli > 1000),            -- HOUSE only; decimal odds x 1000
  UNIQUE (market_id, outcome_code),
  UNIQUE (id, market_id)                                                       -- lets bet_entries prove outcome ∈ market
);

CREATE TABLE market_rules (
  market_id          bigint PRIMARY KEY REFERENCES markets(id),
  resolution_source  text NOT NULL,
  resolution_method  text NOT NULL,
  cancellation_rules text NOT NULL,
  postponement_rules text NOT NULL,
  payout_rules       text NOT NULL
);

CREATE TABLE market_participants (
  market_id bigint NOT NULL REFERENCES markets(id),
  user_id   bigint NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, user_id)               -- P2P: one entry per user per market, enforced by the database
);

CREATE TABLE bet_entries (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id             bigint NOT NULL REFERENCES markets(id),
  user_id               bigint NOT NULL REFERENCES users(id),
  outcome_id            bigint NOT NULL,
  stake_minor           bigint NOT NULL CHECK (stake_minor > 0),
  accepted_odds_milli   int,                                                   -- locked at acceptance (HOUSE)
  potential_payout_minor bigint,                                               -- HOUSE gross payout at accepted odds
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WON','LOST','VOID','REFUNDED')),
  payout_minor          bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (outcome_id, market_id) REFERENCES market_outcomes (id, market_id)   -- cannot bet on another market's outcome
);
CREATE INDEX idx_bets_market ON bet_entries(market_id);
CREATE INDEX idx_bets_user   ON bet_entries(user_id);

CREATE TABLE market_invitations (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id         bigint NOT NULL REFERENCES markets(id),
  invited_user_id   bigint REFERENCES users(id),
  invited_username  text,
  invitation_token  text UNIQUE NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id      bigint NOT NULL REFERENCES markets(id),
  version_number int NOT NULL,
  snapshot       jsonb NOT NULL,
  changed_by     bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, version_number)
);
CREATE TABLE market_reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id   bigint NOT NULL REFERENCES markets(id),
  reviewer_id bigint NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('APPROVED','REJECTED','RETURNED')),
  comments    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id   bigint NOT NULL REFERENCES markets(id),
  reporter_id bigint NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACTIONED','DISMISSED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Wallet & double-entry ledger ─────────────
CREATE TABLE wallets (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  bigint NOT NULL REFERENCES users(id),
  currency text NOT NULL DEFAULT 'KES',
  status   text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN')),
  UNIQUE (user_id, currency)                      -- one wallet per currency per user
);

-- Convention: balance_minor = credits − debits. Every account type is credit-normal; the system
-- clearing account (SYS_FUNDING) goes negative as simulated money is issued — that mirrors real
-- payment-provider clearing and keeps sum(all balances) = 0 at all times (checked by reconciliation).
CREATE TABLE ledger_accounts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id      bigint REFERENCES wallets(id),
  account_type   text NOT NULL CHECK (account_type IN (
                   'AVAILABLE','RESERVED_P2P','RESERVED_HOUSE','PENDING_WITHDRAWAL',
                   'SYS_FUNDING','SYS_HOUSE_BANK','SYS_P2P_COMMISSION','SYS_WITHDRAWAL_CLEARING')),
  currency       text NOT NULL DEFAULT 'KES',
  balance_minor  bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  CONSTRAINT no_overdraft CHECK (allow_negative OR balance_minor >= 0),
  UNIQUE (wallet_id, account_type)
);
CREATE UNIQUE INDEX uq_system_account ON ledger_accounts(account_type, currency) WHERE wallet_id IS NULL;

CREATE TABLE ledger_transactions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference               text UNIQUE NOT NULL,   -- idempotency key
  transaction_type        text NOT NULL,
  status                  text NOT NULL DEFAULT 'POSTED',
  description             text,
  market_id               bigint REFERENCES markets(id),
  reverses_transaction_id bigint REFERENCES ledger_transactions(id),
  created_by              bigint REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions(id),
  account_id     bigint NOT NULL REFERENCES ledger_accounts(id),
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_entries_tx      ON ledger_entries(transaction_id);
CREATE INDEX idx_entries_account ON ledger_entries(account_id);

-- Every ledger transaction must balance — enforced by the database at COMMIT.
CREATE FUNCTION assert_tx_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'),0),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'),0)
    INTO d, c FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF d <> c THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced (debits %, credits %)', NEW.transaction_id, d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_tx_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_tx_balanced();

-- Financial history is append-only. Corrections are new reversing transactions, never edits.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ltx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payment_intents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id),
  provider     text NOT NULL DEFAULT 'SIMULATOR',
  reference    text UNIQUE NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED','EXPIRED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE payment_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider           text NOT NULL,
  event_id           text NOT NULL,
  provider_reference text NOT NULL,
  payload_hash       text NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)                    -- a callback can never credit the same deposit twice
);
CREATE TABLE withdrawal_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  destination   text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','REJECTED')),
  reference     text UNIQUE NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   bigint REFERENCES users(id),
  completed_at  timestamptz
);
CREATE TABLE escrow_allocations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id    bigint NOT NULL REFERENCES markets(id),
  bet_entry_id bigint NOT NULL REFERENCES bet_entries(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status       text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','RELEASED','REFUNDED'))
);
CREATE TABLE commission_records (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id         bigint UNIQUE NOT NULL REFERENCES markets(id),
  gross_stakes_minor bigint NOT NULL,
  commission_minor  bigint NOT NULL,
  status            text NOT NULL DEFAULT 'RECOGNISED' CHECK (status IN ('RECOGNISED','REVERSED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE financial_reconciliations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_by         bigint REFERENCES users(id),
  run_at         timestamptz NOT NULL DEFAULT now(),
  variance_minor bigint NOT NULL,
  status         text NOT NULL,
  report         jsonb NOT NULL
);

-- ───────────── Settlement ─────────────
CREATE TABLE settlements (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id   bigint NOT NULL REFERENCES markets(id),
  outcome_id  bigint,                                  -- NULL => market voided, all stakes refunded
  status      text NOT NULL CHECK (status IN ('PROPOSED','EXECUTED','REJECTED','REVERSED')),
  proposed_by bigint NOT NULL REFERENCES users(id),
  approved_by bigint REFERENCES users(id),
  summary     jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  FOREIGN KEY (outcome_id, market_id) REFERENCES market_outcomes (id, market_id)
);
-- A market can never be settled twice, and never has two live proposals.
CREATE UNIQUE INDEX uq_settlement_executed ON settlements(market_id) WHERE status = 'EXECUTED';
CREATE UNIQUE INDEX uq_settlement_proposed ON settlements(market_id) WHERE status = 'PROPOSED';

CREATE TABLE settlement_evidence (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id bigint NOT NULL REFERENCES settlements(id),
  source_url    text NOT NULL,
  note          text,
  evidence_hash text NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settlement_approvals (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id bigint NOT NULL REFERENCES settlements(id),
  approver_id   bigint NOT NULL REFERENCES users(id),
  decision      text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  comments      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payouts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id bigint NOT NULL REFERENCES settlements(id),     -- a payout must reference a settlement
  user_id       bigint NOT NULL REFERENCES users(id),
  bet_entry_id  bigint NOT NULL REFERENCES bet_entries(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  status        text NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','REVERSED'))
);
CREATE TABLE refunds (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id    bigint NOT NULL REFERENCES markets(id),
  user_id      bigint NOT NULL REFERENCES users(id),
  bet_entry_id bigint REFERENCES bet_entries(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE disputes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id  bigint NOT NULL REFERENCES markets(id),
  user_id    bigint NOT NULL REFERENCES users(id),
  reason     text NOT NULL,
  evidence   text,
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REJECTED','CORRECTED','VOIDED')),   -- REJECTED = original settlement stands
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispute_resolutions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id  bigint NOT NULL REFERENCES disputes(id),
  resolution  text NOT NULL,
  reviewer_id bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── AI (versioned) ─────────────
CREATE TABLE ai_analyses (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id     bigint REFERENCES markets(id),
  analysis_type text NOT NULL,
  model_version text NOT NULL,
  summary       jsonb NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_probabilities (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_id bigint NOT NULL REFERENCES ai_analyses(id),
  outcome_id  bigint NOT NULL REFERENCES market_outcomes(id),
  probability numeric(6,5) NOT NULL CHECK (probability > 0 AND probability < 1)
);
CREATE TABLE odds_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id      bigint NOT NULL REFERENCES markets(id),
  outcome_id     bigint NOT NULL REFERENCES market_outcomes(id),
  old_odds_milli int,
  new_odds_milli int NOT NULL,
  changed_by     bigint REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Audit & notifications ─────────────
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   bigint,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Integrity triggers ─────────────
-- A user cannot join a market that is not OPEN or whose participation deadline has passed.
CREATE FUNCTION assert_market_open() RETURNS trigger AS $$
DECLARE m markets%ROWTYPE;
BEGIN
  SELECT * INTO m FROM markets WHERE id = NEW.market_id;
  IF m.status <> 'OPEN' THEN
    RAISE EXCEPTION 'Market % is not open for participation (status %)', m.id, m.status;
  END IF;
  IF m.closes_at <= now() THEN
    RAISE EXCEPTION 'Market % closed at %', m.id, m.closes_at;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bet_requires_open_market BEFORE INSERT ON bet_entries
  FOR EACH ROW EXECUTE FUNCTION assert_market_open();

-- Market conditions cannot be silently modified once financial participation has started.
CREATE FUNCTION protect_committed_market() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bet_entries WHERE market_id = OLD.id) AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.market_type IS DISTINCT FROM OLD.market_type OR NEW.stake_mode IS DISTINCT FROM OLD.stake_mode
    OR NEW.fixed_stake_minor IS DISTINCT FROM OLD.fixed_stake_minor
    OR NEW.min_stake_minor IS DISTINCT FROM OLD.min_stake_minor OR NEW.max_stake_minor IS DISTINCT FROM OLD.max_stake_minor
    OR NEW.distribution IS DISTINCT FROM OLD.distribution OR NEW.event_at IS DISTINCT FROM OLD.event_at) THEN
    RAISE EXCEPTION 'Market % has committed funds: its terms can no longer be changed', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_market_terms_locked BEFORE UPDATE ON markets
  FOR EACH ROW EXECUTE FUNCTION protect_committed_market();

CREATE FUNCTION protect_committed_outcomes() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bet_entries WHERE market_id = COALESCE(OLD.market_id, NEW.market_id)) THEN
    IF TG_OP = 'DELETE' OR TG_OP = 'INSERT'
       OR NEW.outcome_name IS DISTINCT FROM OLD.outcome_name OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code THEN
      RAISE EXCEPTION 'Outcomes of market % are locked: funds are committed', COALESCE(OLD.market_id, NEW.market_id);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_outcomes_locked BEFORE INSERT OR UPDATE OR DELETE ON market_outcomes
  FOR EACH ROW EXECUTE FUNCTION protect_committed_outcomes();
