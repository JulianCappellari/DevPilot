# Project state (2026-11-23)

| Capacidad (spec) | Estado | Evidencia |
|---|---|---|
| Monorepo, TS strict, lint, vitest, CI | VERIFIED | npm run check; CI GitHub success |
| Maquinas de estado tarea/run, CAS de version, aprobacion por diffHash, politicas de costo | VERIFIED | packages/domain/test |
| Paths contra roots, redaccion de secretos, allowlist de comandos | VERIFIED | packages/security/test |
| Contratos Zod, envelope, SSE con cursor | VERIFIED | packages/contracts/test |
| SQLite (node:sqlite), auditoria append-only, cola con lease | VERIFIED | apps/api/test/e2e.test.ts |
| Auth (scrypt, sesion, CSRF, rate limit), roots, proyectos, tareas (filtros, edicion, archivo) | VERIFIED | e2e + navegador |
| Worker: worktree, checks reales, diff, cancel, timeout, UNKNOWN tras reinicio | VERIFIED | e2e + navegador |
| Revision: aprobacion ligada a diffHash con TOCTOU, override de QA con motivo | VERIFIED | e2e |
| Proveedores: mock, mock-writer, ollama-local (gemma4:12b) | VERIFIED (ollama-local con modelo real) | packages/providers/test + navegador |
| Clasificacion Ollama + fallback heuristico | VERIFIED | e2e + navegador |
| UI vanilla accesible + CSP estricta + PWA (sw solo shell) | VERIFIED manualmente | navegador |
| Benchmark gemma3:12b / gemma4:12b / qwen3.5:9b | VERIFIED | docs/benchmarks |
| Codex | NOT_INTEGRATED (interfaz por validar) | provider codex = Unavailable |
| PostgreSQL/Prisma | NOT_USED (ADR-014) | - |
| Sandbox de procesos (contenedor/VM), Tailscale+TLS, GitHub PR, contexto Markdown, backup programado | NOT_STARTED | - |
