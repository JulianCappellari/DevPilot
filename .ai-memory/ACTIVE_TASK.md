# Active task
- Estado de T-20261123-005: DONE. Implementación del SRS y validación local completadas en `codex/devpilot-release`. La matriz RF-001–042 quedó en `docs/architecture/TRAZABILIDAD.md`.
- Estado de T-20261123-006: entrega publicada y CI aprobado. PR #1 en borrador en `codex/devpilot-release`. Verificación en el iPhone y autenticación local de GitHub CLI dependen de los accesos del propietario.
- Verificaciones: 136/136 pruebas con Docker/Codex/Ollama, 84,31 % de ramas y 4/4 Playwright con axe. El corte real, la restauración y la prueba de Codex desde el worker separado volvieron a pasar. Carga p95 4,61 ms. Benchmark Gemma con ejecución en Docker: 22/22 checks de código y 8/8 clasificaciones con JSON válido.
- Windows: Codex ya estaba autenticado. GitHub CLI 2.105.0 instalado. Tarea `DevPilot Backup` registrada a las 03:00 de Argentina y ejecutada con resultado 0, SQLite íntegro y configuración legible.
- DevPilot en ejecución en loopback. Tailscale Serve HTTPS privado probado desde Windows, sin Funnel, con cookie segura y origen configurados en el archivo local ignorado. El iPhone reportó fallo de resolución y Windows no encontró ningún par en la tailnet.
- Siguiente: vincular el iPhone a la misma tailnet y verificar el login. Completar la credencial de GitHub CLI para probar lectura desde DevPilot. Ya se creó y leyó el PR real con el conector de GitHub.

## Checkpoint anterior
- Status: DONE para implementación y validación local. Despliegue en iPhone/GitHub real pendiente de acceso externo.
- Task ID: T-20261123-004
- Prompt ID: P-20261123-004
- Agent: Codex
- Updated: 2026-11-23
- Baseline: main @ 567d617. Cambios del usuario en package.json y docs/INSTRUCTIVO.md preservados.
- Goal: Implementar y validar los pendientes de docs/INSTRUCTIVO.md, preservando controles de autorización, aislamiento, auditoría y revisión.
- Implementación: runner Docker, proveedor Codex con JSONL y consentimiento, origen HTTPS/PWA, backup y restore, worker separado, métricas, contexto Markdown y PR opcional con autorización propia. Diagrama C4, runbook y demo MP4.
- Verificación: 130 tests con flags de Docker, Ollama y Codex PASS; cobertura de ramas 84,31 %; Playwright + axe 2/2 PASS. Corte real y restauración PASS. Carga p95 4,25–9,25 ms. Codex real en repo sintético pasó consentimiento, aprobación inicial, worktree, QA y aprobación del commit con worker separado. Script Scheduler validado con WhatIf.
- Entorno local: `.env` ignorado por Git creado sin secretos, con Docker y Codex write. Existe propietario en la base local. GitHub desactivado por defecto.
- Próximo paso operativo: iniciar la app local con `npm start`. Para iPhone configurar la tailnet y HTTPS. Para PR real instalar/autenticar GitHub CLI y habilitar el flag por decisión del propietario. SQLite soporta el despliegue de un escritor.
