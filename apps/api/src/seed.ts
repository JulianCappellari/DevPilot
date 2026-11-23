import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "@devpilot/runner";
import { get, newId, nowIso, run, type Config, type DB } from "@devpilot/storage";

/** Siembra los roots configurados por entorno (sólo directorios existentes, canonizados). */
export function seedRoots(db: DB, config: Config): string[] {
  const added: string[] = [];
  for (const p of config.projectRoots) {
    try {
      const real = realpathSync(p);
      if (!get(db, "SELECT id FROM allowed_root WHERE canonical_path = ?", real)) {
        run(db, "INSERT INTO allowed_root(id,canonical_path,enabled,created_at) VALUES(?,?,1,?)", newId("root"), real, nowIso());
        added.push(real);
      }
    } catch { /* root inexistente: se ignora */ }
  }
  return added;
}

/** Crea un repositorio Git de demostración con scripts de QA reales (sin dependencias). */
export async function createDemoRepo(parent: string): Promise<string> {
  const repo = path.join(parent, "demo-app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "demo-app", version: "1.0.0", private: true,
    scripts: { lint: "node scripts/check.js lint", test: "node scripts/check.js test", typecheck: "node scripts/check.js typecheck", build: "node scripts/check.js build" },
  }, null, 2));
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  writeFileSync(path.join(repo, "scripts", "check.js"), "console.log('check', process.argv[2], 'ok');\n");
  writeFileSync(path.join(repo, "README.md"), "# demo-app\n\nRepositorio de demostración de DevPilot.\n");
  const g = (...args: string[]) => runCommand({ file: "git", args: ["-c", "user.name=DevPilot", "-c", "user.email=devpilot@localhost", ...args], cwd: repo, timeoutMs: 30_000 });
  await g("init", "-b", "main");
  await g("add", "-A");
  const r = await g("commit", "-m", "Commit inicial de demo");
  if (r.exitCode !== 0) throw new Error("No se pudo crear el repo demo: " + r.stderr);
  return realpathSync(repo);
}
