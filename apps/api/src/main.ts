import { defaultProviders } from "@devpilot/providers";
import { acquireDataLock, backupSettings, loadConfig, openDb, startBackups } from "@devpilot/storage";
import { startWorker } from "../../worker/src/worker.js";
import { buildApp } from "./app.js";
import { seedRoots } from "./seed.js";

const config = loadConfig();
const releaseData = acquireDataLock(config.dataDir, "service");
const releaseWorker = config.embeddedWorker ? acquireDataLock(config.dataDir, "worker") : undefined;
const db = openDb(config.dbFile);
const providers = defaultProviders({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel }, config.codexMode);
seedRoots(db, config);

const app = buildApp({ db, config, providers, logger: true });
await app.listen({ host: config.host, port: config.port });
const worker = config.embeddedWorker ? startWorker({ db, config, providers, log: (message, fields) => app.log.info(fields ?? {}, message) }) : undefined;
const stopBackups = startBackups(db, config.dataDir, config.backupIntervalMs, (message, error) => {
  if (error) app.log.error({ err: error }, message);
  else app.log.info(message);
}, backupSettings(config));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  stopBackups();
  await worker?.stop();
  await app.close();
  db.close();
  releaseWorker?.();
  releaseData();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost")
  app.log.warn(`El backend escucha en ${config.host}: exponelo sólo por red privada autenticada (RNF-001)`);
