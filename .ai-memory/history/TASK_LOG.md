# Task Log

| Task ID | Date | Agent | Prompt IDs | Status | Changed paths | Validation | Session |
|---|---|---|---|---|---|---|---|

## T-20261123-001 PARTIAL (2026-11-23)
Monorepo + domain/security/contracts/providers + docs. Validacion: typecheck PASS, lint PASS, vitest 56/56 PASS. Bug hallado y corregido: redaccion de JSON con clave entrecomillada. Pendiente: spec 16.1 paso 03 en adelante.

## T-20261123-002 DONE (2026-11-23)
Programa funcional E2E. Decisiones ADR-014..017 (SQLite, UI vanilla, worker embebido, runner unico con child_process). Bugs hallados y corregidos: redaccion JSON con clave entrecomillada; auditoria DENIED sin entityId; cabecera Cache-Control ausente en estaticos; estilos inline bloqueados por CSP; texto null en layout. Validacion: typecheck/lint PASS, vitest 76/76, flujo manual en navegador PASS.

## T-20261123-003 DONE (2026-11-23)
ollama-local (gemma4:12b) como agente real de escritura con validacion de rutas todo-o-nada; benchmark de 3 modelos (docs/benchmarks); filtros/edicion/archivo en UI; PWA. Ollama actualizado 0.30.7->0.40.16 (autorizado). Hallazgos: ollama ps subinforma VRAM de gemma4; mkdir recursivo atravesaba symlinks (corregido). Validacion: vitest 109/109, flujo real con gemma4 en navegador PASS.
