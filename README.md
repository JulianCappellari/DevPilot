# DevPilot

Plataforma personal local-first para orquestar y supervisar agentes de programación. Registra proyectos Git dentro de raíces autorizadas, gestiona tareas con criterios de aceptación, ejecuta agentes en worktrees aislados, corre QA determinista y exige aprobación humana ligada al hash del diff. Especificación: `DP-SPEC-001` v1.0. Costo incremental objetivo: USD 0.

## Inicio rápido (Windows 11, Node 24)

```powershell
npm ci
Copy-Item .env.example .env
npm run setup     # crea el propietario y muestra la contraseña UNA vez
npm run demo      # repo Git de demostración con checks lint/test/typecheck
npm start         # http://127.0.0.1:4000
```

Ingresá con `owner` y la contraseña mostrada. Abrí **Proyectos → demo-app**, creá una tarea con criterios y solicitá una ejecución con `mock-writer` u `ollama-local`. Después de autorizar el inicio, revisá los checks y el diff. La aprobación crea un commit local en `devpilot/<runId>`. La publicación opcional a GitHub requiere otra aprobación.

Otros comandos disponibles incluyen `npm run backup`, `npm run restore -- <archivo>`, `npm run reset-password` y `npm run check`.

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
| QA Docker sin red, instalación npm aislada y cancelación | Probado en Docker Desktop Windows |
| Codex CLI con consentimiento, perfil restringido y aprobación de inicio | Probado con repositorio sintético |
| Copias automáticas, retención y restauración | Probado con corte y recuperación |
| Contexto Markdown versionado y PR con autorización propia | Probado en la API, GitHub simulado |
| Etiquetas, dependencias, revisión asistida con Claude Code e informes anonimizados | Pruebas API y navegador |
| Recorrido de navegador, axe y carga | `npm run test:browser` y `npm run test:operations` |

## Limitaciones conocidas

- **Persistencia: SQLite (`node:sqlite`)**, no PostgreSQL. Ver ADR-014. La cola se puede mover a PostgreSQL sin cambiar el dominio (RNF-028).
- **`ollama-local` es un agente de una sola pasada**: lee hasta 12 archivos chicos, devuelve hasta 8 archivos completos y no ejecuta herramientas ni itera. Sirve para documentación y ediciones simples; no para cambios grandes. Su salida es una propuesta no verificada: la verifican los checks y tu revisión del diff.
- Docker prepara proyectos npm con lockfile. Los paquetes que requieren scripts de instalación necesitan una preparación compatible.
- El acceso desde Safari físico requiere configurar una tailnet con HTTPS. Codex en Windows requiere MXC. La publicación real requiere GitHub CLI autenticada.

[Instructivo](docs/INSTRUCTIVO.md) · [Seguridad](SECURITY.md) · [Diagramas C4](docs/architecture/C4.md) · [Trazabilidad del PDF](docs/architecture/TRAZABILIDAD.md) · [Decisiones](docs/architecture/ADR.md)
