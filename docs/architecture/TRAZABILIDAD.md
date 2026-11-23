# Trazabilidad de DP-SPEC-001 v1.0

La tabla corresponde a los requisitos funcionales de las páginas 9 y 10 del PDF. Los casos de uso se verifican con API, navegador o una instancia descartable según el entorno que necesitan.

| Requisitos | Implementación y evidencia |
| --- | --- |
| RF-001–002 | Login local, sesiones expiran y se revocan. Pruebas API y Playwright. |
| RF-003–005 | Registro por raíz autorizada, estado Git y controles para activar, desactivar y archivar. |
| RF-006–008 | Tareas, criterios, etiquetas, filtros, historial de estado y versiones. Pruebas API. |
| RF-009–012 | Disponibilidad de proveedores, mock, clasificación y resumen JSON local, Codex CLI. El recorrido operativo admite Codex real sobre un repo sintético. |
| RF-013–020 | Inicio autorizado, worktree, job durable, exclusión, SSE, cancelación y límites configurables de QA. Se registra `PARTIAL` si el agente deja cambios antes de fallar, y `UNKNOWN` ante un corte sin resultado verificable. |
| RF-021–025 | Diff y estados de archivo, entrega sujeta a aprobación del árbol Git, checks npm permitidos con salida, código, duración y entorno. La UI muestra si QA pasó, falló o quedó sin evidencia. |
| RF-026–028 | Auditoría de decisiones, APIs pagas deshabilitadas por defecto y origen de costo registrado al solicitar cada ejecución. |
| RF-029–030 | Contexto Markdown registrado por huella, decisiones y pendientes en JSON. Las propuestas se someten al flujo de diff y aprobación. |
| RF-031–032 | PWA responsive, pantalla offline y cookies seguras con origen HTTPS registrado. Playwright emula un iPhone. La verificación sobre un iPhone físico requiere la tailnet. |
| RF-033–034 | Consulta paginada de issues y PR con bandera de lectura separada. La publicación usa otra aprobación vinculada al SHA y al repositorio. Pruebas con GitHub simulado. |
| RF-035 | Pantalla Informes con tareas, resultados, duración media, éxito por proveedor y consumo por origen. Las cantidades representan ejecuciones registradas. |
| RF-036 | Revisión asistida de Claude Code en la aplicación oficial. DevPilot prepara el diff con consentimiento y registra el texto de los hallazgos ligado al hash. |
| RF-037 | Backup SQLite consistente, configuración operativa permitida con checksum, retención y restauración verificada. |
| RF-038 | Ollama y Codex son adaptadores programáticos bajo el contrato `AgentProvider` versión 1. |
| RF-039 | Dependencias acíclicas del mismo proyecto. Cada tarea queda habilitada cuando todas las anteriores requeridas se aprueban y exige su propia autorización. |
| RF-040 | `npm run bench:models` ejecuta escenarios reproducibles sobre Ollama, mide aciertos y valida código en Docker. Las pruebas operativas verifican por proveedor si se obtuvo y revisó el cambio esperado. |
| RF-041 | En Docker, QA corre sin red en un volumen temporal con cuota y límites de CPU, memoria y procesos. La instalación npm usa el lockfile y deshabilita scripts de ciclo de vida. |
| RF-042 | Descarga Markdown con conteos y duraciones agregados. El exportador prescinde de rutas, títulos, nombres de proveedores personalizados, diffs, logs y credenciales. |

La aprobación inicial queda ligada a las versiones de tarea y proyecto. Una edición del alcance o de los checks invalida la solicitud pendiente. Git rechaza una captura que excede el límite de salida y DevPilot bloquea la entrega cuando la revisión detecta un archivo sensible. La cuota de almacenamiento se aplica al entorno de QA en Docker. El tamaño del worktree en el host también depende de las cuotas y permisos del sistema operativo.

El despliegue usa la arquitectura local de los ADR vigentes, con Fastify, frontend web y SQLite para un escritor. PostgreSQL, Next.js y un adaptador adicional para OpenCode aparecen en las propuestas de arquitectura y evolución del PDF. La validación de GitHub real, Tailscale y el Programador de tareas de una instalación depende de la configuración del propietario.
