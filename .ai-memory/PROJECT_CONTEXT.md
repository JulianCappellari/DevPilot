# Project Context — DevPilot
- Memory schema: 2.0
- Updated: 2026-11-23
- Last agent: Claude Code (Sonnet 5.5)
- Branch/HEAD: main, sin commits (repo git inicializado en esta sesión)
- Evidence freshness: VERIFIED con typecheck + lint + vitest el 2026-11-23

## Purpose and scope
DevPilot: plataforma personal local-first (web/PWA) para orquestar y supervisar agentes de programación: proyectos Git autorizados, tareas con criterios de aceptación, ejecución en worktrees, QA determinista, revisión humana ligada al diff. Costo incremental objetivo USD 0. Fuente de verdad del producto: `DevPilot_Especificacion_Ingenieria_Software_v1_0.pdf` (DP-SPEC-001, en Downloads, fuera del repo). DOCUMENTED.

## Current implementation status
See [PROJECT_STATE.md](PROJECT_STATE.md). Resumen: hecho = MVP funcional E2E (API, worker, UI, SQLite). Ver PROJECT_STATE.

## Confirmed stack, versions, commands
VERIFIED: Node 24.21, npm 11.16 (workspaces; pnpm ausente), TypeScript ~6.0.3, Vitest 5.1.1, ESLint 10 + typescript-eslint 8.73, Zod 4.6.7.
Comandos: `npm run check` (typecheck+lint+test), `npm run test:coverage` (umbral 80 %).
Entorno: Windows 11, RTX 4070 Super 12 GB, Docker y Ollama presentes; psql y codex NO instalados.
PROPOSED (spec): Next.js, Fastify, PostgreSQL + Prisma, worker Node, Ollama + Qwen3 8B, SSE, Tailscale.

## Architecture and navigation
Monolito modular + worker (ADR-001). `packages/*` consumidos desde `src/` sin build. Ver [architecture/SYSTEM.md](architecture/SYSTEM.md) y `docs/architecture/ADR.md`.

## Critical security and business invariants
Backend decide estados (RN-019); aprobación ligada a hash de diff, con caducidad y un solo uso (RN-020); QA deriva de exitCode (RN-010); API paga off por defecto (RN-007); paths canonizados dentro de roots (RN-016); sólo comandos allowlisted sin shell; `child_process` prohibido por ESLint fuera de `apps/worker`.

## Active work
See [ACTIVE_TASK.md](ACTIVE_TASK.md).

## Recent tasks and next actions
See [history/TASK_LOG.md](history/TASK_LOG.md), [handoffs/LATEST_HANDOFF.md](handoffs/LATEST_HANDOFF.md). Siguiente: spec §16.1 paso 03 (PostgreSQL + Prisma + login).

## Unknowns, risks and freshness
- PostgreSQL no instalado: usar contenedor Docker (Docker Desktop no verificado en ejecución).
- Interfaces oficiales de Codex y política de Claude Code por validar antes de F4/F6 (spec §22.1).
- Runner en Windows: `npm.cmd` no se lanza sin shell; resolver `node npm-cli.js`.
