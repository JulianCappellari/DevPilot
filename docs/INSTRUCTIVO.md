# Instructivo de DevPilot

## 1. Puesta en marcha

Requisitos en Windows: Node 24, Git y Docker Desktop con contenedores Linux para aislar los checks. Ollama y Codex son opcionales para el flujo de demostración.

```powershell
npm ci
Copy-Item .env.example .env
npm run setup
npm run demo
npm start
```

Abrí `http://127.0.0.1:4000`. Ingresá con `owner` y la contraseña que mostró `setup`. Usá `npm run reset-password` para cambiarla y revocar las sesiones anteriores.

| Variable | Configuración |
|---|---|
| `HOST`, `PORT` | `127.0.0.1` y `4000` por defecto |
| `DATA_DIR`, `WORKSPACE_ROOT` | Base SQLite, copias y worktrees en rutas locales escribibles |
| `PROJECT_ROOTS` | Raíces autorizadas, separadas por punto y coma. También se administran desde Seguridad |
| `SANDBOX` | `docker` en el ejemplo. `none` ejecuta QA con los permisos de Windows y se reserva para repos de confianza |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Ollama en loopback y `gemma4:12b` por defecto |
| `CODEX_MODE` | `off`, `read-only` o `write` |
| `ENABLE_PAID_APIS` | `false` por defecto |
| `RUN_TIMEOUT_MINUTES`, `CHECK_TIMEOUT_SECONDS` | Plazo de la ejecución y de cada check |
| `BACKUP_INTERVAL_HOURS` | `24` por defecto. `0` desactiva el backup automático |
| `EMBEDDED_WORKER` | `true` por defecto. Con `false`, usar también `npm run worker` |
| `COOKIE_SECURE`, `ALLOWED_ORIGINS` | Activar cookies seguras y configurar la URL HTTPS exacta para el acceso por proxy |
| `ENABLE_GITHUB_PR` | `false` por defecto. Habilita una acción de publicación con aprobación separada |
| `ENABLE_GITHUB_READ` | `false` por defecto. Habilita la consulta de issues y PR del remoto autorizado |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY_MIB`, `SANDBOX_PIDS`, `SANDBOX_WORKSPACE_MIB` | Límites de QA Docker. Defaults: 2 CPU, 2048 MiB de RAM, 256 procesos y 512 MiB para el volumen de trabajo |

Para usar el modelo local, instalá una versión de Ollama compatible y ejecutá `ollama pull gemma4:12b`. En **Agentes** podés chequear la disponibilidad de los modelos y del sandbox. Registrá los repos desde **Proyectos** después de autorizar su raíz.

## 2. Uso diario

1. Creá una tarea con título y criterios de aceptación, uno por línea. La clasificación local es opcional.
2. Elegí `mock-writer`, `ollama-local` o Codex cuando esté habilitado. Al elegir Codex, confirmá el aviso de envío de contexto.
3. Elegí **Aprobar e iniciar**. DevPilot crea un worktree en una rama `devpilot/<id>`.
4. Revisá la línea de tiempo, la salida de cada check y el diff. Un check fallido o la falta de evidencia requiere una excepción con motivo para aprobar.
5. **Aprobar** crea un commit local a partir del árbol Git revisado. También podés pedir cambios o rechazar. El historial y la auditoría se conservan.
6. Integrá manualmente la rama o usá la acción opcional para abrir un PR en borrador.

Un corte durante el trabajo deja la ejecución en `UNKNOWN` al reiniciar. Prepará un intento nuevo desde la tarea. Un diff pendiente que se generó antes del cambio de huella de esta versión puede requerir pedir cambios y generar un intento nuevo.

En **Editar tarea**, agregá etiquetas y elegí las tareas requeridas. DevPilot habilita la solicitud cuando los prerrequisitos están aprobados. Si cambia la tarea o la configuración del proyecto después de solicitar una ejecución, cancelá la solicitud anterior y generá otra.

## 3. Configuración y verificación de las funciones

### 3.1 Docker y dependencias

Con `SANDBOX=docker`, DevPilot copia el worktree a un volumen Docker descartable. Si hay dependencias npm, usa `npm ci --ignore-scripts` con un archivo de bloqueo. Sólo la instalación accede al registro. Los checks se ejecutan sin red, con un usuario no root, límites de recursos y raíz del contenedor de sólo lectura. Los archivos que escriben los checks quedan en el volumen. Si el motor Linux no responde, los checks se bloquean.

El modo está probado en Docker Desktop sobre Windows con un proyecto que instala un paquete de prueba, un check de acceso a la red y una cancelación. Los proyectos cuyos paquetes requieren scripts de instalación necesitan preparar una imagen o adaptar sus checks al modo que permite el sandbox.

### 3.2 Codex

Instalá la CLI oficial, iniciá sesión con ChatGPT usando `codex login` y comprobá `codex login status`. Empezá con `CODEX_MODE=read-only`. Cambiá a `write` para permitir ediciones dentro del worktree. DevPilot usa JSONL y un perfil de archivos de Codex que restringe el acceso al worktree, bloquea rutas sensibles conocidas y deshabilita red en los comandos. Windows requiere que el sandbox nativo MXC esté disponible.

La solicitud de ejecución y la autorización de inicio son dos pasos. La aprobación del diff es un paso posterior. La cuenta de ChatGPT puede consumir cuota de suscripción. [Modo no interactivo de Codex](https://learn.chatgpt.com/docs/non-interactive-mode) · [Sandbox de Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox).

### 3.3 iPhone por Tailscale

Mantené `HOST=127.0.0.1`. Conectá la PC y el iPhone a la misma tailnet. Habilitá HTTPS en Tailscale y configurá el reenvío privado en la PC con el puerto de DevPilot:

```powershell
tailscale serve --bg http://127.0.0.1:4000
tailscale serve status
```

En `.env`, configurá `COOKIE_SECURE=true` y `ALLOWED_ORIGINS=https://<equipo>.<tailnet>.ts.net`. Reiniciá la app, ingresá mediante esa URL en Safari y usá **Añadir a pantalla de inicio**. Para desactivar el acceso remoto usá `tailscale serve --https=443 off`.

La app incluye íconos PNG y un shell offline que muestra el aviso de desconexión. Se verificaron el control de origen y la PWA en navegador móvil emulado. La prueba sobre un iPhone conectado a la tailnet requiere esos dispositivos. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

### 3.4 Backups, restauración y worker

El servidor genera una copia SQLite consistente al arrancar si ya toca un backup y después según el intervalo configurado. Conserva las siete fechas diarias más recientes y una copia de cada una de hasta cuatro semanas anteriores. `npm run backup` crea una copia inmediata en `DATA_DIR/backups`.

Consultá los parámetros respaldados con `npm run backup:config -- ruta/al/backup.db`. Se guardan opciones operativas seleccionadas y su checksum. Elegí qué opciones aplicar a la instalación destino antes de arrancarla.

Para restaurar, detené la API y cualquier worker que use el mismo `DATA_DIR`:

```powershell
npm run restore -- ruta/al/backup.db
```

La restauración comprueba la integridad y conserva la base anterior como `devpilot.db.bak` si existe. Para generar copias aunque la API esté cerrada, ejecutá `./scripts/Register-DevPilotBackup.ps1 -At 03:00` desde la cuenta de Windows que usa DevPilot. La tarea programada corre mientras esa cuenta tiene una sesión abierta. Pasá `-WhatIf` para ver qué registraría. Seguí el [runbook de recuperación](runbooks/RECUPERACION.md) para probar una copia en otra carpeta. Los repos Git se respaldan por separado.

Con `EMBEDDED_WORKER=false`, ejecutá `npm start` y `npm run worker` con el mismo `DATA_DIR`. Se admite un worker activo por carpeta de datos. `GET /api/v1/metrics` requiere una sesión y muestra recuentos de ejecuciones, jobs y checks. Los logs y la auditoría de una ejecución comparten el identificador de correlación de su autorización.

### 3.5 Pruebas

```powershell
npm run check
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm run test:operations
```

La suite de navegador incluye axe y un escenario móvil offline. La prueba operativa carga el dashboard con diez clientes, corta un proceso de DevPilot durante QA, reinicia y restaura una copia en un directorio vacío. El [runbook](runbooks/RECUPERACION.md) documenta el resultado.

Para Docker y los agentes reales, habilitá las pruebas que corresponden a tu entorno:

```powershell
$env:DEVPILOT_TEST_DOCKER = '1'
npm run test:run -- packages/runner/test/container.test.ts
$env:DEVPILOT_TEST_OLLAMA = '1'
npm run test:run -- packages/providers/test/real.test.ts
$env:DEVPILOT_TEST_CODEX = '1'
npm run test:operations
```

Los agentes reales usan repositorios descartables y contenido sintético. Codex requiere una sesión ChatGPT activa y puede consumir cuota.

### 3.6 PR en GitHub

Para consultar **Issues y PR de GitHub**, habilitá `ENABLE_GITHUB_READ=true` y abrí el enlace en la pantalla del proyecto. La credencial puede tener permisos de lectura de Issues y Pull requests sobre ese repositorio. El acceso de escritura sólo es necesario para la publicación. [Permisos de GitHub](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Activá `ENABLE_GITHUB_PR=true`, instalá GitHub CLI e iniciá sesión con una credencial con permisos de contenido y PR sobre el repositorio. Conservá la autenticación en el almacén de credenciales del sistema. DevPilot delega la autenticación a `gh` y no guarda el token. El remoto `origin` debe apuntar a un único repositorio en `github.com`.

Después de aprobar un diff, elegí **Crear PR en GitHub** y confirmá el repositorio, la rama y el commit. DevPilot valida una aprobación separada y de un solo uso, publica la rama de la ejecución y crea un PR en borrador. La integración a la rama base se hace en GitHub. Si GitHub rechaza los permisos, el commit local queda disponible. [Autenticación de GitHub CLI](https://cli.github.com/manual/gh_auth_login).

### 3.7 Contexto Markdown

En **Proyectos → Contexto Markdown**, registrá la ruta relativa de un archivo `.md`. La vista detecta cambios externos por SHA-256 y permite registrar la nueva versión. Con Ollama podés solicitar un resumen de decisiones y pendientes. Para editar, prepará una propuesta y autorizá su ejecución para generar el diff. Revisá y aprobá ese diff para obtener un commit en la rama de la tarea.

### 3.8 Operación del host

Usá una cuenta de Windows sin privilegios de administrador y limitá el acceso a los repos, worktrees y copias con los permisos de carpeta de esa cuenta. SQLite cubre el despliegue local con un escritor. La migración a PostgreSQL queda como opción para un despliegue que requiera varios escritores.

### 3.9 Revisión manual e informes

Desde un diff completo, abrí **Revisión manual con Claude Code**. Confirmá que podés usar tu cuenta en la aplicación oficial. Prepará y revisá el material antes de compartirlo y pegá los hallazgos en DevPilot. La revisión manual queda registrada junto al diff y la aprobación continúa en el flujo habitual. [Condiciones de Claude Code](https://code.claude.com/docs/en/legal-and-compliance).

Abrí **Informes** para ver resultados por estado, tiempos y ejecuciones por origen de costo. Usá **Descargar informe técnico anonimizado** para exportar las métricas agregadas. `npm run bench:models -- gemma4:12b` guarda resultados de escenarios reproducibles en `data/benchmarks`. Docker debe estar activo para evaluar el código generado.

## 4. Checklist de aceptación del MVP

[Matriz completa de RF de la especificación](architecture/TRAZABILIDAD.md).

| Criterio | Evidencia |
|---|---|
| Proyecto autorizado, tarea, checks, diff y aprobación | Playwright y pruebas API |
| Ejecución real con Codex, autorización previa y worktree | Prueba operativa con un repo sintético |
| Modelo local frente a instrucciones hostiles en README | Prueba con Gemma 4 |
| Aislamiento y dependencias | Docker Desktop Windows |
| Accesibilidad y PWA offline | Playwright, axe y emulación móvil |
| Carga, corte real, reinicio y restauración | [Runbook](runbooks/RECUPERACION.md) |
| Arquitectura | [Diagramas C4](architecture/C4.md) |
| Recorrido de demostración | Video subtitulado de 3:12 en `data/demo/devpilot.mp4` en el entorno de trabajo |
| Uso remoto por Tailscale en un iPhone físico | Requiere la tailnet y el teléfono |

## 5. Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| Docker no está disponible | Abrí Docker Desktop y confirmá que usa contenedores Linux. Verificá `docker info` |
| No se instalan dependencias | Confirmá que el repo incluye su lockfile y que la instalación admite `--ignore-scripts` |
| Codex no está disponible | Revisá el modo, la sesión de ChatGPT y MXC en Windows |
| Ollama no encuentra el modelo | Verificá `ollama list` y `OLLAMA_MODEL` |
| `EADDRINUSE` | Ajustá `PORT` y el destino de Tailscale Serve si corresponde |
| `403 Origen no permitido` | Cargá la URL HTTPS exacta en `ALLOWED_ORIGINS` |
| Safari no encuentra el servidor `.ts.net` | Abrí Tailscale en el iPhone. Conectalo a la misma tailnet y comprobá que aparece la PC en la lista de dispositivos. MagicDNS resuelve nombres dentro de esa red. |
| `403 Token CSRF inválido` | Cerrá sesión y volvé a entrar |
| Ejecución `UNKNOWN` | Conservá la evidencia y prepará un intento nuevo |
| Restauración rechazada | Detené la API y el worker que usan el directorio |
| PR rechazado | Verificá `gh auth status`, el remoto y los permisos del repositorio |
