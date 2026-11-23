import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupTo, get, type DB } from "./db.js";
import type { Config } from "./config.js";

export function backupSettings(config: Config) {
  return {
    version: 1,
    port: config.port,
    sandbox: config.sandbox,
    runTimeoutMs: config.runTimeoutMs,
    checkTimeoutMs: config.checkTimeoutMs,
    sessionTtlMs: config.sessionTtlMs,
    cookieSecure: config.cookieSecure,
    embeddedWorker: config.embeddedWorker,
    backupIntervalMs: config.backupIntervalMs,
  };
}

type BackupSettings = ReturnType<typeof backupSettings>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function readBackupSettings(db: DB): BackupSettings | null {
  if (!get(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_settings'")) return null;
  const row = get<{ content: string; checksum: string }>(db, "SELECT content,checksum FROM backup_settings WHERE id=1");
  if (!row || sha256(row.content) !== row.checksum) throw new Error("El checksum de configuración del backup no coincide");
  const content = JSON.parse(row.content) as BackupSettings;
  if (content.version !== 1) throw new Error("Versión de configuración de backup no soportada");
  return content;
}

export function inspectBackupSettings(source: string): BackupSettings | null {
  const db = new DatabaseSync(source, { readOnly: true });
  try { return readBackupSettings(db); } finally { db.close(); }
}

/** Un lock de SQLite libera el proceso incluso si se corta sin ejecutar el cierre. */
export function acquireDataLock(dir: string, kind: "service" | "restore" | "worker"): () => void {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, kind === "worker" ? ".worker-lock.db" : ".maintenance-lock.db"));
  try {
    db.exec("PRAGMA busy_timeout=1500");
    if (kind === "service") {
      db.exec("BEGIN; SELECT name FROM sqlite_schema LIMIT 1");
    } else {
      db.exec("BEGIN EXCLUSIVE");
      if (kind === "worker") db.exec("CREATE TABLE IF NOT EXISTS owner(lock INTEGER)");
    }
  } catch (error) {
    db.close();
    throw new Error(kind === "worker" ? "Ya hay un worker usando este DATA_DIR" : "DATA_DIR está ocupado; detené DevPilot antes de restaurar", { cause: error });
  }
  return () => db.close();
}

const DAY_MS = 86_400_000;
const BACKUP_NAME = /^devpilot-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f-]+)?\.db$/;
const weekKey = (date: string) => {
  const timestamp = Date.parse(date);
  const offset = (new Date(timestamp).getUTCDay() + 6) % 7;
  return timestamp - offset * DAY_MS;
};

export function pruneBackups(dir: string): void {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  const days = new Set<string>();
  const weeks = new Set<number>();
  const keptWeeks = new Set<number>();
  for (const name of names) {
    const date = BACKUP_NAME.exec(name)![1]!;
    const week = weekKey(date);
    if (days.size < 7 && !days.has(date)) {
      days.add(date);
      keptWeeks.add(week);
      continue;
    }
    if (!keptWeeks.has(week) && !weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      continue;
    }
    rmSync(path.join(dir, name), { force: true });
  }
}

export function createBackup(db: DB, dataDir: string, now = new Date(), settings?: BackupSettings): string {
  const dir = path.join(dataDir, "backups");
  const dest = path.join(dir, `devpilot-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.db`);
  const temp = dest + ".tmp";
  try {
    backupTo(db, temp);
    if (settings) {
      const copy = new DatabaseSync(temp);
      try {
        const content = JSON.stringify(settings);
        copy.exec("CREATE TABLE IF NOT EXISTS backup_settings(id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL, checksum TEXT NOT NULL)");
        copy.prepare("INSERT OR REPLACE INTO backup_settings(id,content,checksum) VALUES(1,?,?)").run(content, sha256(content));
      } finally { copy.close(); }
    }
    renameSync(temp, dest);
    pruneBackups(dir);
    return dest;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function startBackups(db: DB, dataDir: string, intervalMs: number, log: (message: string, error?: unknown) => void, settings?: BackupSettings): () => void {
  if (!intervalMs) return () => undefined;
  const tick = () => {
    try {
      const dir = path.join(dataDir, "backups");
      const latest = existsSync(dir) ? readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort().at(-1) : undefined;
      const date = latest && /^devpilot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(latest);
      const last = date ? Date.parse(`${date[1]}T${date[2]}:${date[3]}:${date[4]}.${date[5]}Z`) : 0;
      if (Date.now() - last >= intervalMs) {
        createBackup(db, dataDir, new Date(), settings);
        log("Backup programado completado");
      }
    } catch (error) { log("Falló el backup programado", error); }
  };
  const timer = setInterval(tick, Math.min(intervalMs, 60_000));
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

export function restoreBackup(dataDir: string, live: string, source: string): void {
  const release = acquireDataLock(dataDir, "restore");
  const candidate = path.join(dataDir, `.restore-${randomUUID()}.db`);
  const fallback = candidate + ".bak";
  try {
    const backup = new DatabaseSync(source, { readOnly: true });
    try {
      const integrity = get<{ integrity_check: string }>(backup, "PRAGMA integrity_check");
      const schema = get<{ n: number }>(backup, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('user','task','run','audit_event')");
      if (integrity?.integrity_check !== "ok" || schema?.n !== 4 || get(backup, "PRAGMA foreign_key_check"))
        throw new Error("El archivo no es un backup íntegro de DevPilot");
      readBackupSettings(backup);
      backupTo(backup, candidate);
    } finally { backup.close(); }

    if (existsSync(live)) {
      const current = new DatabaseSync(live);
      try {
        backupTo(current, fallback);
        const checkpoint = get<{ busy: number }>(current, "PRAGMA wal_checkpoint(TRUNCATE)");
        if (checkpoint?.busy) throw new Error("Cerrá las conexiones activas a la base de datos");
      } finally { current.close(); }
      renameSync(fallback, live + ".bak");
    }
    for (const suffix of ["-wal", "-shm"]) rmSync(live + suffix, { force: true });
    renameSync(candidate, live);
  } finally {
    rmSync(candidate, { force: true });
    rmSync(fallback, { force: true });
    release();
  }
}
