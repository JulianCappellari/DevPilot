import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireDataLock, backupSettings, createBackup, get, inspectBackupSettings, loadConfig, openDb, pruneBackups, restoreBackup, run } from "../src/index.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "devpilot-backup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it("conserva siete fechas diarias y cuatro semanas anteriores sin tocar otros archivos", () => {
  writeFileSync(path.join(dir, "manual.db"), "");
  for (let i = 1; i <= 49; i++) {
    const stamp = new Date(Date.UTC(2026, 8, i)).toISOString().replace(/[:.]/g, "-");
    writeFileSync(path.join(dir, `devpilot-${stamp}.db`), "");
  }
  pruneBackups(dir);
  expect(readdirSync(dir).filter((name) => name.startsWith("devpilot-"))).toHaveLength(11);
  expect(readdirSync(dir)).toContain("manual.db");
});

it("restaura auditoría y tareas con una copia local de la base anterior y rechaza una base en uso", () => {
  const file = path.join(dir, "devpilot.db");
  const db = openDb(file);
  run(db, "INSERT INTO audit_event(action,entity_type,outcome,created_at) VALUES('snapshot','run','OK','2026-11-23')");
  const backup = createBackup(db, dir);
  run(db, "INSERT INTO audit_event(action,entity_type,outcome,created_at) VALUES('after','run','OK','2026-11-23')");
  db.close();

  const releaseA = acquireDataLock(dir, "service");
  const releaseB = acquireDataLock(dir, "service");
  try {
    expect(() => restoreBackup(dir, file, backup)).toThrow(/ocupado/);
  } finally { releaseA(); releaseB(); }
  restoreBackup(dir, file, backup);
  for (const [name, count] of [[file, 1], [file + ".bak", 2]] as const) {
    const restored = openDb(name);
    expect(get(restored, "SELECT COUNT(*) AS n FROM audit_event")).toMatchObject({ n: count });
    restored.close();
  }
  const corrupt = path.join(dir, "invalid.db");
  writeFileSync(corrupt, "not sqlite");
  expect(() => restoreBackup(dir, file, corrupt)).toThrow();
  const restored = openDb(file);
  expect(get(restored, "SELECT action FROM audit_event")).toMatchObject({ action: "snapshot" });
  restored.close();
});

it("guarda sólo configuración operativa permitida y verifica su huella antes de restaurar", () => {
  const live = path.join(dir, "devpilot.db");
  const db = openDb(live);
  const config = loadConfig({ SANDBOX: "docker", PORT: "4200", OLLAMA_BASE_URL: "http://user:demo-secret@localhost", ENABLE_GITHUB_READ: "true" });
  const backup = createBackup(db, dir, new Date(), backupSettings(config));
  db.close();
  const saved = inspectBackupSettings(backup);
  expect(saved).toMatchObject({ sandbox: "docker", port: 4200 });
  expect(JSON.stringify(saved)).not.toContain("demo-secret");
  const copy = openDb(backup);
  run(copy, "UPDATE backup_settings SET checksum='bad'");
  copy.close();
  expect(() => restoreBackup(dir, live, backup)).toThrow(/checksum/);
});
