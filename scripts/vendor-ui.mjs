// Empaqueta las librerías de UI como archivos estáticos locales (la CSP sólo admite 'self').
// Uso: npm run vendor:ui. Los resultados se versionan en apps/web/public/{vendor,fonts}.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const out = "apps/web/public";
mkdirSync(out + "/vendor", { recursive: true });
mkdirSync(out + "/fonts", { recursive: true });

// Motion mini: animate sobre WAAPI (~3 KB), suficiente para toasts, diálogos y feedback de estado.
await build({
  stdin: { contents: 'export { animate } from "motion/mini";', resolveDir: process.cwd() },
  bundle: true, format: "esm", minify: true, target: "es2022",
  outfile: out + "/vendor/motion.js", legalComments: "none", banner: { js: "/* motion (MIT) https://motion.dev */" },
});

for (const [pkg, file] of [["inter", "inter-latin-wght-normal.woff2"], ["jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2"]]) {
  copyFileSync(`node_modules/@fontsource-variable/${pkg}/files/${file}`, `${out}/fonts/${file}`);
}
