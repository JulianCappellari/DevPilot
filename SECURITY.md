# Seguridad

DevPilot puede modificar código e invocar procesos; su riesgo es mayor que el de un dashboard. Modelo de amenazas completo en la spec §13.

## Principios vigentes en el código

- El backend decide estados, permisos y límites; el modelo sólo propone (RN-006, RN-019).
- Las rutas se canonizan y se rechazan traversal, symlinks y junctions fuera de los roots (`@devpilot/security`).
- QA ejecuta los comandos de la allowlist con argv tipado. Con `SANDBOX=docker` el volumen de trabajo es descartable y los checks quedan sin acceso a red.
- La aprobación del diff se liga al árbol de Git y la publicación en GitHub requiere una aprobación distinta, ligada al commit y al destino, con vencimiento y un solo uso.
- Los secretos se redactan antes de llegar a logs, eventos o errores.
- Ninguna API de pago se usa sin `ENABLE_PAID_APIS=true` **y** consentimiento por proveedor.

## Limitaciones conocidas

- Reservá `SANDBOX=none` para proyectos propios o de confianza. En ese modo, los scripts de QA se ejecutan con los permisos del host.
- El perfil de Codex restringe el acceso al worktree, deshabilita red en sus comandos y protege rutas sensibles conocidas. El contexto autorizado puede enviarse al servicio de OpenAI. La detección de secretos por patrones tiene cobertura limitada.
- Para compartir la app por Tailscale Serve, mantené la API en loopback, configurá una cookie segura y registrá únicamente el origen HTTPS exacto.
- La validación de paths tiene una ventana TOCTOU inherente; hay que revalidar justo antes de operar.

## Reporte

Proyecto personal sin servicio expuesto. Reportar vulnerabilidades abriendo un issue privado en el repositorio.
