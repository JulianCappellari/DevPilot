# Project state (2026-11-23)

| Capacidad (spec) | Estado | Evidencia |
|---|---|---|
| Monorepo, TS strict, lint, vitest, CI (F1 base) | VERIFIED | npm run check |
| Maquinas de estado tarea/run con CAS de version (spec 6.1) | VERIFIED | packages/domain/test |
| Aprobacion ligada a diffHash, caducidad, un solo uso (RN-020) | VERIFIED | idem |
| Politica API paga off por defecto (RN-007, T-012) | VERIFIED | idem |
| Paths contra roots, traversal, junction (RNF-004, T-001/002) | VERIFIED | packages/security/test |
| Redaccion de secretos (RNF-006, T-011) | VERIFIED (por patrones) | idem |
| Allowlist de comandos (T-008) | VERIFIED (politica); runner NO existe | idem |
| Contratos Zod, envelope, SSE | VERIFIED | packages/contracts/test |
| MockProvider | VERIFIED | packages/providers/test |
| PostgreSQL/Prisma, auth, API Fastify, UI Next.js, worker, cola | NOT_STARTED | - |
| Ollama, Codex, worktrees, QA runner, diff/review, backups, PWA, Tailscale | NOT_STARTED | - |
