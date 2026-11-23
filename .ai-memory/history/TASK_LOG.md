# Task Log

| Task ID | Date | Agent | Prompt IDs | Status | Changed paths | Validation | Session |
|---|---|---|---|---|---|---|---|

## T-20261123-001 PARTIAL (2026-11-23)
Monorepo + domain/security/contracts/providers + docs. Validacion: typecheck PASS, lint PASS, vitest 56/56 PASS. Bug hallado y corregido: redaccion de JSON con clave entrecomillada. Pendiente: spec 16.1 paso 03 en adelante.

## T-20261123-002 DONE (2026-11-23)
Programa funcional E2E. Decisiones ADR-014..017 (SQLite, UI vanilla, worker embebido, runner unico con child_process). Bugs hallados y corregidos: redaccion JSON con clave entrecomillada; auditoria DENIED sin entityId; cabecera Cache-Control ausente en estaticos; estilos inline bloqueados por CSP; texto null en layout. Validacion: typecheck/lint PASS, vitest 76/76, flujo manual en navegador PASS.

## T-20261123-003 DONE (2026-11-23)
ollama-local (gemma4:12b) como agente real de escritura con validacion de rutas todo-o-nada; benchmark de 3 modelos (docs/benchmarks); filtros/edicion/archivo en UI; PWA. Ollama actualizado 0.30.7->0.40.16 (autorizado). Hallazgos: ollama ps subinforma VRAM de gemma4; mkdir recursivo atravesaba symlinks (corregido). Validacion: vitest 109/109, flujo real con gemma4 en navegador PASS.

## T-20261123-004 DONE (2026-11-23, Codex)

Implementación local de pendientes de DevPilot. Archivos principales: `packages/runner/src/{exec,container,git}.ts`, `packages/providers/src/{codex,markdown,ollama}.ts`, `packages/storage/src/{config,db,maintenance,repo}.ts`, `apps/api/src/{app,routes,context,github,cli,main}.ts`, `apps/worker/src/{worker,main}.ts`, `apps/web/public/`, `apps/web/browser/`, `.github/workflows/ci.yml` y `scripts/Register-DevPilotBackup.ps1`. Evidencia y operación en `docs/INSTRUCTIVO.md`, `docs/architecture/C4.md` y `docs/runbooks/RECUPERACION.md`. Demo 192 s en `data/demo/devpilot.mp4`.

Decisiones: Docker copia el worktree a un volumen separado, ejecuta QA sin red y usa contenedor Linux con usuario no root. Codex usa una sesión ChatGPT propia con perfil restringido MXC, sin acceso de red para comandos y consentimiento persistido por run. La revisión firma el árbol de Git y el PR exige autorización separada asociada al SHA y remoto. SQLite continúa con un escritor y locks entre API, worker y restore. GitHub CLI conserva la autenticación y DevPilot no persiste tokens.

Verificación: typecheck/lint PASS; 130/130 con pruebas opcionales de Docker, Codex y Ollama incluidas; cobertura ramas 84,31 %; Playwright y axe 2/2; corte real, restore, carga y Codex end to end con worker separado PASS. El script del programador Windows pasó WhatIf. Ajustes durante verificación: globs de permisos Codex con ruta absoluta; normalización CRLF para comparar el Markdown de un worktree con el original; exclusión de trazas de Playwright del lint.

Pendiente de entorno externo: Tailscale/HTTPS en un iPhone real, publicación GitHub con credencial de un repo y CI remoto. PostgreSQL es una migración condicional a múltiples escritores. Cambios locales, sin push.

## T-20261123-005 DONE (2026-11-23, Codex)

Se contrastó el PDF DP-SPEC-001 con el código. Se agregaron etiquetas y dependencias acíclicas, control de versión de alcance en autorizaciones, registro del entorno de QA y de costos, resúmenes JSON, lectura de GitHub, revisión manual, analítica e informe anónimo, configuración de backup con checksum y QA en volumen Docker con cuota. Se bloquean diffs incompletos y archivos sensibles antes de la entrega. Cambios en `apps/api/src/{routes,github,report,manual-review,classify,context,bench-models}.ts`, `apps/web/public/`, `apps/worker/src/worker.ts`, `packages/{runner,storage,contracts,security}`, suites API, runner y navegador, e instructivo y matriz de trazabilidad.

Validación: 136/136 tests con Docker/Codex/Ollama, 84,31 % ramas, 4/4 Playwright y axe en GitHub usando doble de API, revisión manual, Informes, PWA y temas. Corte, restauración y Codex con worker separado PASS, p95 4,61 ms. Gemma generó resumen JSON válido y el benchmark obtuvo 22/22 verificaciones de código en Docker. Se amplió sólo el timeout de T-009 tras observar demora de subprocesos Windows con otras suites concurrentes.

## T-20261123-006 IN_PROGRESS (2026-11-23, Codex)

El propietario autorizó la rama de entrega y el PR en borrador. Se prepararon los commits `167f5e9` y `1adcfa7`, preservando el rediseño y las licencias de terceros. Se instaló GitHub CLI y se inició su autenticación oficial. Codex ya estaba instalado y autenticado. La tarea de backup está registrada y produjo una copia verificable al probarla.

### T-20261123-006 · Entrega y despliegue en Windows

PR #1 abierto como borrador y rama publicada. El primer CI detectó que el script de empaquetado usaba `process` sin importarlo. Se corrigió en `243e55e` y el workflow 45283460772 pasó completo, incluidos Playwright, recuperación y Docker Linux. Auditoría de producción local: 0 vulnerabilidades.

Tailscale 1.104.7 quedó instalado y autenticado por el propietario. Serve responde sólo en la tailnet, y DevPilot escucha sólo en `127.0.0.1:4000`. Se verificaron HTTPS, manifest PWA y protección de la sesión. En la prueba inicial, Safari no resolvió el nombre y Windows registró cero pares en la tailnet. La vinculación del iPhone y la autenticación de GitHub CLI dependen del propietario. La creación del borrador y la lectura real de GitHub se verificaron con el conector. La demo local de 3:12 se inspeccionó en su versión previa de la UI.

## T-20261123-006 DONE (2026-11-23, Claude Code)

Rediseño UX/UI completo de apps/web: tokens OKLCH con tema claro/oscuro y selector manual, shell persistente con navegación lateral y barra inferior móvil, iconos SVG, fases de ejecución, informes con barras, esqueletos de carga, View Transitions y Motion mini (toasts, diálogos, pulso de estado). Tipografías Inter y JetBrains Mono locales. Decisiones y librerías descartadas en `docs/architecture/UI.md`. Archivos: `styles.css`, `app.js`, `index.html`, `sw.js` (cache v4), `ui/*`, `vendor/motion.js`, `fonts/`, `scripts/vendor-ui.mjs`, `scripts/preview-ui.ts`, `eslint.config.js`, spec Playwright (+1 prueba de tema oscuro). Bug hallado: `replaceChildren` convertía `null` en texto "null" (corregido con filtro). Validación: `npm run check` 133/133 PASS; Playwright + axe 3/3 PASS (claro, oscuro, móvil); sin desbordes horizontales en 6 rutas a 375 px. No verificado: iPhone físico, navegadores no Chromium (View Transitions degrada a corte directo).
