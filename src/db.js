import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cast_members (username TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shows (date TEXT PRIMARY KEY, name TEXT, call_time TEXT);
    CREATE TABLE IF NOT EXISTS registrations (
      show_date TEXT NOT NULL, username TEXT NOT NULL, registered_at TEXT NOT NULL,
      method TEXT NOT NULL, marked_by TEXT, PRIMARY KEY (show_date, username));
  `);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// YYYY-MM-DD for `now` in the given IANA time zone (en-CA formats as ISO date).
export function todayIn(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}
