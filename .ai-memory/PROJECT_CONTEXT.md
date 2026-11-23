# Project Context — DevPilot
- Memory schema: 2.0
- Updated: 2026-11-23
- Last agent: Codex
- Branch: `codex/devpilot-release` derivada de `main` @ `567d617`.
- Evidence freshness: VERIFIED el 2026-11-23 con 136 tests, Docker, agentes reales, 4 escenarios Playwright con axe y prueba operativa.

## Purpose and scope
DevPilot: plataforma personal local-first (web/PWA) para orquestar y supervisar agentes de programación: proyectos Git autorizados, tareas con criterios de aceptación, ejecución en worktrees, QA determinista, revisión humana ligada al diff. Costo incremental objetivo USD 0. Fuente de verdad del producto: `DevPilot_Especificacion_Ingenieria_Software_v1_0.pdf` (DP-SPEC-001, en Downloads, fuera del repo). DOCUMENTED.

## Current implementation status
MVP local E2E: API, worker, SQLite, UI/PWA, QA aislado en Docker, Ollama y Codex con consentimiento, backups, restauración, contexto Markdown y GitHub optativo. T-005 agregó etiquetas y dependencias, lectura GitHub, revisión manual, informes, exportación anonimizada, trazabilidad y límites configurables de QA. Ver `docs/architecture/TRAZABILIDAD.md` y [handoff](handoffs/LATEST_HANDOFF.md).

## Confirmed stack, versions, commands
VERIFIED: Node 24.21, npm 11.16 (workspaces; pnpm ausente), TypeScript ~6.0.3, Vitest 5.1.1, ESLint 10 + typescript-eslint 8.73, Zod 4.6.7.
Comandos: `npm run check`, `npm run test:coverage` (umbral 80 %), `npm run test:browser` y `npm run test:operations`.
Entorno verificado: Windows 11, Docker Desktop con motor Linux, Ollama con Gemma 4 12B y Codex CLI con autenticación de ChatGPT y MXC.
PROPOSED (spec): Next.js, Fastify, PostgreSQL + Prisma, worker Node, Ollama + Qwen3 8B, SSE, Tailscale.

## Architecture and navigation
Monolito modular + worker (ADR-001). `packages/*` consumidos desde `src/` sin build. Ver [architecture/SYSTEM.md](architecture/SYSTEM.md) y `docs/architecture/ADR.md`.

## Critical security and business invariants
Backend decide estados (RN-019). La aprobación liga el árbol de Git y exige otra autorización para publicar un PR. QA deriva de exitCode (RN-010) y Docker queda sin red durante los checks. El consentimiento externo se persiste. Los paths se canonizan dentro de roots y sólo `packages/runner` puede lanzar procesos.

## Active work
See [ACTIVE_TASK.md](ACTIVE_TASK.md).

## Recent tasks and next actions
Ver [history/TASK_LOG.md](history/TASK_LOG.md) y [handoffs/LATEST_HANDOFF.md](handoffs/LATEST_HANDOFF.md). Siguiente despliegue opcional: validar iPhone/tailnet y publicación GitHub con el repositorio que el propietario autorice.

## Unknowns, risks and freshness
- SQLite sigue siendo el almacenamiento compatible con un escritor. PostgreSQL es condicional a un despliegue multiescritor.
- Tailscale e iPhone físico requieren la cuenta, el dispositivo y su configuración. GitHub real requiere cliente y credenciales.
- Backups automáticos y restauración verificados. La tarea programada Windows quedó registrada y una ejecución manual produjo una copia verificable.
