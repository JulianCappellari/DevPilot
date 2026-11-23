// Arranca una instancia descartable con un repo de demostración para revisar la interfaz a mano.
// Uso: npx tsx scripts/preview-ui.ts   (imprime la URL, el usuario owner y la contraseña de la sesión)
import { fixture } from "../apps/web/browser/server.js";

const demo = await fixture();
const server = await demo.start({ PORT: "4100" });
console.log(`PREVIEW ${server.url} usuario=owner contraseña=${demo.password} repo=${demo.repo}`);
const stop = async () => { await server.stop(); demo.remove(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
