# Latest handoff

## Cierre de T-20261123-005 y entrega T-20261123-006 · Codex · 2026-11-23

- T-005 DONE. Matriz RF-001–042 en `docs/architecture/TRAZABILIDAD.md`. Implementación y validación local sobre la base existente de SQLite y UI web.
- 136/136 tests reales y unitarios PASS, 84,31 % de ramas, 4/4 Playwright con axe. La consulta GitHub usa un doble en API y navegador. Carga p95 4,61 ms, corte y restauración PASS. Codex real entregó el resultado revisado con worker separado. Resumen Gemma JSON PASS y 22/22 pruebas del benchmark aislado PASS.
- T-006 entrega publicada. Rama `codex/devpilot-release`, PR #1 en borrador. CI 45283460772 PASS en `243e55e`, luego de corregir el lint de `scripts/vendor-ui.mjs`. Se creó y consultó el PR real con el conector de GitHub. GitHub CLI instalado y login pendiente.
- Se registró `DevPilot Backup` diario a las 03:00 de Argentina. La prueba manual del Programador devolvió resultado 0 y `npm run backup:config` leyó la copia creada.
- Tailscale instalado y autenticado. Serve HTTPS privado responde desde Windows y la API escucha en loopback. Cookie segura y origen configurados en `.env` local. Inicialmente Safari no pudo resolver el nombre y Windows mostró cero pares en la tailnet. Próximo paso: vincular el iPhone y probar el login. La creación de PR desde DevPilot conserva evidencia simulada hasta autenticar GitHub CLI y autorizar un caso real propio.

## T-20261123-004 · Codex · 2026-11-23

- Prompt: P-20261123-004. Implementar todas las funciones pendientes para dejar DevPilot listo para uso local.
- Estado: DONE en código y validación local. `main` @ `567d617` con cambios locales. No se hicieron commit ni push. `.env` local ignorado sin secretos, `SANDBOX=docker` y `CODEX_MODE=write`.
- Entregado: QA aislado e instalación npm, Codex con consentimiento y MXC, PWA PNG y origen HTTPS, copias retención y restore, tarea Windows instalable, worker separado y métricas, Markdown versionado y propuestas, publicación GitHub con aprobación por SHA y destino. C4, runbook y demo de 3:12.
- Verificado: `npm run check` con Docker/Codex/Ollama habilitados 130/130; cobertura de ramas 84,31 %; navegador Chromium 2/2 con axe y offline; carga p95 4,25–9,25 ms; corte de proceso QA y restauración en carpeta vacía; worker separado con Codex real y revisión del árbol; Scheduler WhatIf. Se corrigieron errores Windows de sintaxis de perfil, CRLF en contexto y acceso de Chromium a loopback desde el runner.
- Configuración y próximos pasos: `docs/INSTRUCTIVO.md`. El propietario existe en la base local. El acceso desde un iPhone físico necesita una tailnet. GitHub requirió un doble de prueba para el caso de permisos y queda pendiente con credenciales reales. No se ejecutó CI remoto ni se registró una tarea del Programador de Windows. PostgreSQL queda condicionado a múltiples escritores.
- Referencias: `../PROJECT_CONTEXT.md`, `../ACTIVE_TASK.md`, `../history/TASK_LOG.md`, `docs/runbooks/RECUPERACION.md`, `docs/architecture/C4.md`, `data/demo/devpilot.mp4`.

## Continuidad del instructivo — 2026-11-23

- VERIFIED por Codex: `main` en `567d617`; Git muestra `main` alineada con la referencia local `origin/main`. Cambios locales recibidos: `package.json` modificado y `docs/INSTRUCTIVO.md` nuevo, todavía sin commit.
- VERIFIED por inspección: los siete scripts de arranque y CLI que cambiaron usan `--env-file-if-exists=.env`. El archivo `.env` está ausente al momento del chequeo.
- REPORTED: el autor comprobó la carga con un `.env` temporal y obtuvo 109 tests aprobados. Validación de esta sesión: inspección de archivos y Git completada; ejecución de tests y prueba funcional de `.env` NOT_RUN.
- Próximo paso documentado: §3.1 de `docs/INSTRUCTIVO.md`, aislar los checks en Docker y preparar las dependencias del worktree. Los argumentos en Windows siguen pendientes de comprobación. Se recibió el plan como traspaso de contexto.

## Handoff anterior

- From agent: Claude Code (Sonnet 5.5)
- To agent: any
- Timestamp: 2026-11-23
- Branch / HEAD / dirty files: main, publicado en origin (github.com/JulianCappellari/DevPilot, repo publico). CI GitHub Actions: success sobre ab96400.
- Active task ID: T-20261123-003 (DONE). Anteriores: T-001 y T-002 DONE.
- Prompt IDs: P-20261123-001..003
- Status: DONE para el alcance del MVP; ver "Unfinished".
- Verified completed work: API Fastify + SQLite (node:sqlite), auth scrypt/sesion httpOnly/CSRF/rate limit, roots y proyectos, tareas (filtros, edicion con version, archivo), cola durable + worker (cancel, timeout, UNKNOWN tras reinicio), worktrees, checks allowlisted, diff + aprobacion por hash, SSE, auditoria append-only, UI vanilla accesible con CSP estricta, PWA (sw solo cachea shell), clasificacion Ollama, proveedor ollama-local (gemma4:12b) probado con modelo real, benchmark de 3 modelos (docs/benchmarks).
- Unfinished work and known failures: Codex sin integrar (interfaz por validar, spec 22.1); PostgreSQL no usado (ADR-014); sin sandbox de procesos (Nivel 2/3); Tailscale/TLS sin configurar; sin GitHub PR, contexto Markdown, backup programado; sin pruebas de carga/caos/WCAG automatizado. Sin fallos conocidos.
- Tests and commands: `npm run typecheck` PASS; `npm run lint` PASS; `npx vitest run --coverage` 109/109 PASS (88,8 % ramas); `npm audit --omit=dev` 0. Flujo completo con gemma4 real en navegador PASS.
- Decisions / invariants to preserve: docs/architecture/ADR.md (ADR-009..019). No hacer push sin pedido del usuario (el primer push se autorizo al dar la URL del repo). Ollama actualizado a 0.40.16 con autorizacion; modelos instalados: gemma4:12b, qwen3.5:9b, gemma3:12b. Nota: `ollama ps` subinforma VRAM de gemma4; usar nvidia-smi.
- Next action: elegir entre spike de Codex (F0), sandbox en contenedor (Docker disponible), acceso privado Tailscale + TLS, PR a GitHub, o migracion a PostgreSQL.
- Required documents: ../PROJECT_CONTEXT.md, ../ACTIVE_TASK.md, ../PROJECT_STATE.md, README.md. Spec: DevPilot_Especificacion_Ingenieria_Software_v1_0.pdf (Downloads, fuera del repo).
- Confidence and freshness: alta, verificado 2026-11-23. PROJECT_STATE.md puede estar atrasado respecto de este archivo: verificar contra el codigo.

## Auditoría de Claude Code sobre el trabajo de Codex — 2026-11-23
- VERIFIED: `npm run check` PASS (typecheck, lint, 133 tests + 3 skipped); cobertura ramas 84,31 % (umbral 80); `npm audit --omit=dev` 0; Docker Linux activo.
- VERIFIED: T-20261123-004 y T-005 (analíticas, GitHub lectura, Claude manual, export anónimo) están en el árbol de trabajo, sin commit ni push. Sin TODO/FIXME en código.
- Faltan en este equipo: `gh`, `tailscale`, `codex` en PATH. Pendiente de entorno: iPhone/tailnet, GitHub real, CI remoto, tarea programada real.
- Recomendado: commit por bloques lógicos; después validar T-005 con Playwright y dejar ACTIVE_TASK en DONE.

## T-20261123-006 · Claude Code · rediseño UI
- DONE y verificado: `npm run check` 133/133; Playwright+axe 3/3; capturas de escritorio claro y móvil oscuro/claro revisadas. Sin commit.
- Ver `docs/architecture/UI.md`. Regenerar librerías: `npm run vendor:ui`. Preview manual: `npx tsx scripts/preview-ui.ts` (se cierra a los 150 s).
- Pendiente: revisar Safari/Firefox y un iPhone real; capturas con datos reales en la ficha de tarea (sólo se miró la ejecución en escritorio); PRODUCT.md/DESIGN.md de Impeccable sin crear.
