/**
 * SQLite layer (T-102): WAL mode, synchronous=FULL for state transitions,
 * Drizzle-managed forward-only raw-SQL migrations executing the normative DDL
 * from architecture §1 verbatim (ADR-022).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

export function openDatabase(dir: string): { db: DB; file: string } {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'clockwork.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // Durability discipline (arch §1): correctness beats write latency at this volume.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  return { db, file };
}

export interface Migrator {
  migrate(): void;
}

/** Forward-only migrations with drizzle-style bookkeeping table. */
export function createMigrator(db: DB, migrations: ReadonlyArray<{ id: string; sql: string }>): Migrator {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const appliedStmt = db.prepare('SELECT id FROM schema_migrations ORDER BY id');
  const recordStmt = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  return {
    migrate(): void {
      const applied = new Set(appliedStmt.all().map((r: any) => r.id as string));
      for (const m of migrations) {
        if (applied.has(m.id)) continue;
        const tx = db.transaction(() => {
          db.exec(m.sql);
          recordStmt.run(m.id, Date.now());
        });
        tx();
      }
    },
  };
}

/** Crash-mid-write probe (S-34 partial): WAL survives abrupt close. */
export function integrityCheck(db: DB): boolean {
  const r = db.pragma('integrity_check', { simple: true });
  return r === 'ok';
}
