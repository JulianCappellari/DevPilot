import { defaultProviders } from "@devpilot/providers";
import { acquireDataLock, loadConfig, openDb } from "@devpilot/storage";
import { startWorker } from "./worker.js";

const config = loadConfig();
const releaseData = acquireDataLock(config.dataDir, "service");
const releaseWorker = acquireDataLock(config.dataDir, "worker");
const db = openDb(config.dbFile);
const providers = defaultProviders({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel }, config.codexMode);
const log: NonNullable<Parameters<typeof startWorker>[0]["log"]> = (message, fields) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), component: "worker", message, ...fields }));
};
const worker = startWorker({ db, config, providers, log });
log("Worker listo");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  db.close();
  releaseWorker();
  releaseData();
};
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
