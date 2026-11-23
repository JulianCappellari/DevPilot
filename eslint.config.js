import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["data/**", "node_modules/**", "coverage/**", "dist/**", ".ai-memory/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-imports": ["error", { paths: ["child_process", "node:child_process"] }],
    },
  },
  { files: ["apps/api/src/**", "apps/worker/**", "packages/**"], languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly", AbortSignal: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", Buffer: "readonly" } } },
  { files: ["**/test/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  {
    files: ["apps/web/**"],
    languageOptions: { globals: { document: "readonly", window: "readonly", fetch: "readonly", EventSource: "readonly", location: "readonly", history: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", URLSearchParams: "readonly", FormData: "readonly", console: "readonly", AbortSignal: "readonly", navigator: "readonly", caches: "readonly", self: "readonly", URL: "readonly" } },
  },
  {
    // Sólo el runner del worker (futuro) podrá lanzar procesos.
    files: ["packages/runner/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
