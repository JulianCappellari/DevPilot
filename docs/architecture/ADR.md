# Registro de decisiones de arquitectura (ADR)

Fuente: especificación DP-SPEC-001 v1.0 §18.1. Estado `Aceptada` = adoptada para el MVP; `Implementada` indica evidencia en código.

| ADR | Decisión | Alternativa descartada | Estado |
|---|---|---|---|
| 001 | Monolito modular (API + dominio) con worker separado | Microservicios prematuros | Aceptada; sólo paquetes de dominio implementados |
| 002 | PostgreSQL como primera cola durable (locking + lease) | Redis/BullMQ de entrada | Aceptada; sin implementar |
| 003 | SSE con cursor `runId:seq` para streaming a la UI | WebSocket bidireccional sin necesidad | Aceptada; formato implementado en `@devpilot/contracts` |
| 004 | Abstracción de proveedores + `MockProvider` | Acoplar la UI al SDK de Codex | Implementada (`@devpilot/providers`) |
| 005 | Local-first y acceso móvil por VPN privada | Servidor público con puertos expuestos | Aceptada; sin implementar |
| 006 | Aprobación humana ligada al hash del diff, con caducidad y un solo uso | Merges o escrituras automáticas | Implementada (`validateApproval`) |
| 007 | Claude Code como integración diferida | Asumir que Claude Pro habilita API de terceros | Aceptada |
| 008 | Modelo pequeño local en Ollama (Qwen3 8B) | Autoalojar un modelo grande para todo | Aceptada; benchmark pendiente (§12.4) |

## Decisiones de implementación propias de esta base

- **ADR-009 — npm workspaces en lugar de pnpm.** pnpm no está instalado en el entorno de referencia; npm workspaces cubre el caso sin dependencias nuevas. Reversible.
- **ADR-010 — TypeScript 6.0.x, no 7.x.** `typescript-eslint` 8.73 declara `typescript <6.1.0`; se fija `~6.0.3` hasta que lo soporte.
- **ADR-011 — Paquetes consumidos desde `src/` sin paso de build.** `main`/`types` apuntan a `src/index.ts`; simplifica el desarrollo. Revisar al incorporar `apps/*` (se usará `tsx` o build de referencias de proyecto).
- **ADR-012 — `child_process` prohibido por ESLint fuera de `apps/worker`.** Hace verificable que sólo el runner lanza procesos (T-008, RNF-005).
- **ADR-013 — Los comandos de QA son `{file, args}` tipados, nunca strings de shell.** Pendiente para el runner en Windows: `npm` es `npm.cmd` y Node no lo lanza sin shell; se resolverá `node npm-cli.js` explícitamente.
- **ADR-014 — SQLite (`node:sqlite`) en lugar de PostgreSQL + Prisma.** Se tomó al construir el MVP porque PostgreSQL no estaba instalado y Docker no estaba en ejecución; SQLite viene con Node 24, no requiere servicios y soporta transacciones `BEGIN IMMEDIATE`, WAL, triggers de append-only y `VACUUM INTO` para backups. Se desvía de ADR-002. Consecuencias: un único host y un único escritor efectivo (coherente con RNF-015). Revisar si se necesita acceso concurrente de varios procesos o migrar la cola a PostgreSQL.
- **ADR-015 — UI sin framework ni build (vanilla ES modules).** Se desvía de la propuesta Next.js/React para evitar toolchain y mantener CSP `script-src 'self'` sin inline. Todo el contenido dinámico usa `textContent`.
- **ADR-016 — Worker embebido en el proceso de la API por defecto.** `apps/worker` es un módulo independiente (`startWorker`) que sólo habla con la BD; puede extraerse a su propio proceso sin cambiar contratos.
- **ADR-017 — `packages/runner` es el único lugar con `child_process`** (regla ESLint). Procesos: `shell:false`, entorno mínimo sin secretos heredados, kill del árbol (`taskkill /T`), salida acotada y redactada; Git con hooks y fsmonitor desactivados.
- **ADR-018 — Proveedor `ollama-local` con propuesta estructurada.** El modelo devuelve JSON `{summary, files[]}` validado con Zod; el proveedor, no el modelo, decide qué se escribe. Todas las rutas se validan *antes* de escribir (relativas, sin `..`, sin `.git*`, sin archivos sensibles, sin nombres reservados de Windows, sin duplicados, ancestro existente dentro del worktree vía `realpath` para impedir `mkdir` a través de symlinks/junctions); una ruta inválida descarta la propuesta completa. El contexto enviado al modelo excluye rutas sensibles y redacta secretos. Se eligió `gemma4:12b` por benchmark propio (`docs/benchmarks`).
- **ADR-019 — Service worker sólo para el shell estático.** `/api/` nunca se cachea ni se intercepta, para no servir datos/estados viejos ni retener contenido autenticado (RN-013).
