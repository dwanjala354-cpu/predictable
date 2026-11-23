-- Predictable — migration 002 (Stage Two): security, AI layer, accumulators.

-- ───────────── Security ─────────────
-- Tamper-evident audit log: each row's hash covers the previous row's hash (verified by an admin endpoint).
-- Rows are written unsealed; a sealer chains them in order (seq) so writers never contend on a single lock.
ALTER TABLE audit_logs ADD COLUMN seq bigint UNIQUE;
ALTER TABLE audit_logs ADD COLUMN prev_hash text;
ALTER TABLE audit_logs ADD COLUMN hash text;
DROP TRIGGER trg_audit_immutable ON audit_logs;
CREATE FUNCTION audit_seal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on audit_logs is not allowed: this table is append-only'; END IF;
  -- The only permitted update is the one-time seal of an unsealed row; no content column may change.
  IF OLD.hash IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.details IS DISTINCT FROM OLD.details OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'UPDATE on audit_logs is not allowed: this table is append-only';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_seal_guard();

ALTER TABLE user_sessions ADD COLUMN ip text;
ALTER TABLE user_sessions ADD COLUMN user_agent text;
ALTER TABLE user_sessions ADD COLUMN last_seen timestamptz NOT NULL DEFAULT now();

CREATE TABLE login_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier text NOT NULL,
  ip         text,
  success    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_ident ON login_attempts(lower(identifier), created_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, created_at);

CREATE TABLE user_mfa (
  user_id        bigint PRIMARY KEY REFERENCES users(id),
  secret_sealed  text NOT NULL,                 -- AES-256-GCM sealed TOTP secret, never plaintext
  enabled        boolean NOT NULL DEFAULT false,
  last_used_step bigint NOT NULL DEFAULT 0,     -- replay protection: a code can be used once
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE step_up_codes (                    -- one-time codes (simulated SMS) for sensitive user actions
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  purpose    text NOT NULL,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appeals (                          -- spec §23.4: sensitive risk decisions need an appeal route
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id),
  message       text NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UPHELD','REINSTATED')),
  reviewed_by   bigint REFERENCES users(id),
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);

-- ───────────── AI: odds intelligence ─────────────
CREATE TABLE team_ratings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sport      text NOT NULL DEFAULT 'football',
  name       text NOT NULL,
  rating     numeric(8,2) NOT NULL DEFAULT 1500,
  matches    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, name)
);
CREATE TABLE rating_updates (                   -- each settled match updates Elo exactly once
  market_id   bigint PRIMARY KEY REFERENCES markets(id),
  home        text NOT NULL, away text NOT NULL,
  home_before numeric(8,2) NOT NULL, away_before numeric(8,2) NOT NULL,
  home_after  numeric(8,2) NOT NULL, away_after numeric(8,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── AI: research intelligence ─────────────
CREATE TABLE research_evidence (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id    bigint NOT NULL REFERENCES markets(id),
  kind         text NOT NULL CHECK (kind IN ('SUPPORT','COUNTER','STAT','CONTEXT','UNKNOWN','RESULT')),
  claim        text NOT NULL,
  source_name  text NOT NULL,
  source_url   text NOT NULL CHECK (source_url ~* '^https?://'),   -- every claim must be traceable to a source
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  fact         jsonb,                              -- structured value for RESULT evidence (score, value)
  origin       text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','FEED')),
  added_by     bigint REFERENCES users(id),
  retracted_at timestamptz,
  retracted_by bigint REFERENCES users(id)
);
CREATE INDEX idx_evidence_market ON research_evidence(market_id);

-- ───────────── AI: market discovery ─────────────
CREATE TABLE information_feeds (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL,
  url             text NOT NULL CHECK (url ~* '^https://'),         -- https only; private addresses are blocked at fetch time
  kind            text NOT NULL DEFAULT 'RSS' CHECK (kind IN ('RSS','JSON')),
  category_slug   text,
  active          boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error      text,
  created_by      bigint REFERENCES users(id),
  UNIQUE (url)
);
CREATE TABLE feed_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_id      bigint NOT NULL REFERENCES information_feeds(id),
  guid         text NOT NULL,
  title        text NOT NULL,
  url          text NOT NULL,
  published_at timestamptz,
  summary      text,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed_id, guid)
);
CREATE TABLE market_suggestions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_item_id  bigint REFERENCES feed_items(id),
  template      text NOT NULL,
  title         text NOT NULL,
  category_slug text NOT NULL,
  outcomes      jsonb NOT NULL,
  rationale     text NOT NULL,
  source_url    text NOT NULL,
  issues        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACCEPTED','DISMISSED')),
  reviewed_by   bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed_item_id, template)
);

-- ───────────── AI-assisted resolution ─────────────
-- A deterministic mapping from a verified fact (score / numeric value) to the winning outcome.
CREATE TABLE market_resolution_specs (
  market_id bigint PRIMARY KEY REFERENCES markets(id),
  kind      text NOT NULL CHECK (kind IN ('MATCH_RESULT','THRESHOLD')),
  params    jsonb NOT NULL,
  set_by    bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE settlements ADD COLUMN origin text NOT NULL DEFAULT 'HUMAN' CHECK (origin IN ('HUMAN','AI_ASSISTED'));
ALTER TABLE settlements ADD COLUMN confidence text;
ALTER TABLE settlements ADD COLUMN required_approvals int NOT NULL DEFAULT 1;
ALTER TABLE settlement_approvals ADD CONSTRAINT uq_one_approval_each UNIQUE (settlement_id, approver_id);

-- ───────────── AI: risk intelligence ─────────────
CREATE TABLE risk_alerts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type  text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  user_id     bigint REFERENCES users(id),
  market_id   bigint REFERENCES markets(id),
  detail      text NOT NULL,
  dedupe_key  text UNIQUE NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','DISMISSED')),
  reviewed_by bigint REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

-- ───────────── Accumulators ─────────────
CREATE TABLE accumulators (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                bigint NOT NULL REFERENCES users(id),
  stake_minor            bigint NOT NULL CHECK (stake_minor > 0),
  combined_odds_milli    bigint NOT NULL CHECK (combined_odds_milli > 1000),
  potential_payout_minor bigint NOT NULL,
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WON','LOST','VOID')),
  payout_minor           bigint NOT NULL DEFAULT 0,
  settle_seq             int NOT NULL DEFAULT 0,        -- bumps on every (re)settlement so ledger references stay unique
  created_at             timestamptz NOT NULL DEFAULT now(),
  settled_at             timestamptz
);
CREATE INDEX idx_acca_user ON accumulators(user_id);
CREATE TABLE accumulator_legs (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accumulator_id      bigint NOT NULL REFERENCES accumulators(id),
  market_id           bigint NOT NULL REFERENCES markets(id),
  outcome_id          bigint NOT NULL,
  accepted_odds_milli int NOT NULL CHECK (accepted_odds_milli > 1000),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','WON','LOST','VOID')),
  UNIQUE (accumulator_id, market_id),                   -- one leg per market: legs from the same market are correlated
  FOREIGN KEY (outcome_id, market_id) REFERENCES market_outcomes (id, market_id)
);
CREATE INDEX idx_legs_market ON accumulator_legs(market_id);

-- A leg can only be placed on an OPEN house market that has not passed its deadline.
CREATE FUNCTION assert_leg_market_open() RETURNS trigger AS $$
DECLARE m markets%ROWTYPE;
BEGIN
  SELECT * INTO m FROM markets WHERE id = NEW.market_id;
  IF m.market_type <> 'HOUSE' THEN RAISE EXCEPTION 'Accumulator legs must be house markets (market % is %)', m.id, m.market_type; END IF;
  IF m.status <> 'OPEN' THEN RAISE EXCEPTION 'Market % is not open for participation (status %)', m.id, m.status; END IF;
  IF m.closes_at <= now() THEN RAISE EXCEPTION 'Market % closed at %', m.id, m.closes_at; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_leg_requires_open_market BEFORE INSERT ON accumulator_legs
  FOR EACH ROW EXECUTE FUNCTION assert_leg_market_open();

-- Committed funds through accumulators freeze market terms exactly as single bets do.
CREATE OR REPLACE FUNCTION protect_committed_market() RETURNS trigger AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM bet_entries WHERE market_id = OLD.id) OR EXISTS (SELECT 1 FROM accumulator_legs WHERE market_id = OLD.id)) AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.market_type IS DISTINCT FROM OLD.market_type OR NEW.stake_mode IS DISTINCT FROM OLD.stake_mode
    OR NEW.fixed_stake_minor IS DISTINCT FROM OLD.fixed_stake_minor
    OR NEW.min_stake_minor IS DISTINCT FROM OLD.min_stake_minor OR NEW.max_stake_minor IS DISTINCT FROM OLD.max_stake_minor
    OR NEW.distribution IS DISTINCT FROM OLD.distribution OR NEW.event_at IS DISTINCT FROM OLD.event_at) THEN
    RAISE EXCEPTION 'Market % has committed funds: its terms can no longer be changed', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_committed_outcomes() RETURNS trigger AS $$
DECLARE mid bigint := COALESCE(OLD.market_id, NEW.market_id);
BEGIN
  IF EXISTS (SELECT 1 FROM bet_entries WHERE market_id = mid) OR EXISTS (SELECT 1 FROM accumulator_legs WHERE market_id = mid) THEN
    IF TG_OP = 'DELETE' OR TG_OP = 'INSERT'
       OR NEW.outcome_name IS DISTINCT FROM OLD.outcome_name OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code THEN
      RAISE EXCEPTION 'Outcomes of market % are locked: funds are committed', mid;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
