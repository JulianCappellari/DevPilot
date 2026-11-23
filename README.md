# DevPilot

Plataforma personal local-first para orquestar y supervisar agentes de programación. Registra proyectos Git dentro de raíces autorizadas, gestiona tareas con criterios de aceptación, ejecuta agentes en worktrees aislados, corre QA determinista y exige aprobación humana ligada al hash del diff. Especificación: `DP-SPEC-001` v1.0. Costo incremental objetivo: USD 0.

## Inicio rápido (Windows 11, Node >= 22)

```powershell
npm install
npm run setup     # crea el propietario y muestra la contraseña UNA vez
npm run demo      # repo Git de demostración con checks lint/test/typecheck
npm start         # http://127.0.0.1:4000
```

Ingresá con `owner` y la contraseña mostrada. Flujo: Proyectos → demo-app → nueva tarea (con criterios) → Solicitar ejecución con `ollama-local` (el modelo escribe el cambio) o `mock-writer` (demo sin IA) → Aprobar e iniciar → revisar diff y checks → Aprobar. Se crea un commit en la rama `devpilot/<runId>`; **nunca** hay merge, push ni deploy.

Otros comandos: `npm run backup` (copia consistente de la BD), `npm run reset-password`, `npm run check` (typecheck + lint + tests).

Variables en `.env.example`. Modelo local por defecto: `gemma4:12b` (elegido por benchmark propio, ver [docs/benchmarks](docs/benchmarks/README.md)); se cambia con `OLLAMA_MODEL`. Requiere Ollama >= 0.30.9 y `ollama pull gemma4:12b`.

## Qué hay implementado (verificado)

| Área | Estado |
|---|---|
| Auth: scrypt, sesión httpOnly/SameSite, CSRF, límite de intentos, revocación | Probado (tests + navegador) |
| Roots autorizados, registro de repos (traversal, symlinks, repos anidados) | Probado |
| Tareas, criterios, máquina de estados con versión optimista, historial | Probado |
| Cola durable con lease, worker, una ejecución escritora, cancelación, timeout, recuperación tras reinicio (UNKNOWN) | Probado |
| Worktree aislado, checks allowlisted sin shell, diff, hash, aprobación atada al hash con TOCTOU | Probado |
| SSE con cursor `runId:seq` y reanudación | Probado |
| Clasificación con Ollama (JSON validado) y fallback heurístico | Probado con modelo real |
| **Proveedor `ollama-local`**: `gemma4:12b` propone archivos y DevPilot los escribe en el worktree (rutas validadas, propuesta todo-o-nada, sin secretos en el contexto) | Probado con tests y de punta a punta con el modelo real |
| Tareas: búsqueda, filtro por estado, orden, edición con versión, archivado | Probado |
| PWA: manifest, service worker que sólo cachea el shell (nunca `/api/`) | Verificada en navegador |
| Auditoría append-only (triggers), redacción de secretos | Probado |
| UI accesible (teclado, foco, contraste, `prefers-color-scheme`, sin `innerHTML`, CSP estricta) | Verificada en navegador (escritorio y ancho móvil) |
| 109 tests, 88,8 % de ramas en dominio/seguridad/proveedores | `npm run test:coverage` |

## Limitaciones conocidas

- **Persistencia: SQLite (`node:sqlite`)**, no PostgreSQL. Ver ADR-014. La cola se puede mover a PostgreSQL sin cambiar el dominio (RNF-028).
- **Codex no está integrado**: figura como no disponible y los runs quedan `BLOCKED`. Su interfaz oficial debe validarse antes (spec §22.1).
- **`ollama-local` es un agente de una sola pasada**: lee hasta 12 archivos chicos, devuelve hasta 8 archivos completos y no ejecuta herramientas ni itera. Sirve para documentación y ediciones simples; no para cambios grandes. Su salida es una propuesta no verificada: la verifican los checks y tu revisión del diff.
- **Sin sandbox de procesos**: un worktree no es un sandbox. Los checks ejecutan scripts del repo (`npm run ...`); usalo sólo con repos propios o confiables. Contenedor/VM (Nivel 2/3) está sin implementar.
- Los worktrees no instalan dependencias: los checks de un proyecto real necesitan `node_modules` accesible.
- Acceso remoto: la PWA existe, pero Tailscale/proxy TLS están sin configurar (ver SECURITY.md). Backup sólo manual (`npm run backup`). Sin integración GitHub ni contexto Markdown (P1). El icono PWA es SVG: algunos navegadores piden PNG para ofrecer la instalación.
- Sin pruebas de carga, de caos del worker real ni auditoría WCAG automatizada.

Seguridad en [`SECURITY.md`](SECURITY.md); decisiones en [`docs/architecture/ADR.md`](docs/architecture/ADR.md).
