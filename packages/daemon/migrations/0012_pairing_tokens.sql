-- Round5-A. Mesh pairing nonces bound to peer WireGuard pubkey (additive).
-- Single-use, 10min expiry, revocation. Stores hashes only, never plaintext.
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash  TEXT PRIMARY KEY,
  pubkey_hash TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_tokens(expires_at);
