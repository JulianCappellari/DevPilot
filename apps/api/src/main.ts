import { defaultProviders } from "@devpilot/providers";
import { loadConfig, openDb } from "@devpilot/storage";
import { startWorker } from "../../worker/src/worker.js";
import { buildApp } from "./app.js";
import { seedRoots } from "./seed.js";

const config = loadConfig();
const db = openDb(config.dbFile);
const providers = defaultProviders({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel });
seedRoots(db, config);

const app = buildApp({ db, config, providers, logger: true });
const worker = startWorker({ db, config, providers, log: (m) => app.log.info(m) });

const shutdown = async () => {
  await worker.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

await app.listen({ host: config.host, port: config.port });
if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost")
  app.log.warn(`El backend escucha en ${config.host}: exponelo sólo por red privada autenticada (RNF-001)`);
