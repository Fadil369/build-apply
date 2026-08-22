-- Atomic rate-limit counters (single-statement UPSERT is serialized by D1)
CREATE TABLE IF NOT EXISTS rl_counters (
  k TEXT PRIMARY KEY,
  w INTEGER NOT NULL,
  c INTEGER NOT NULL
);
