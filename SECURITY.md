# Seguridad

DevPilot puede modificar código e invocar procesos; su riesgo es mayor que el de un dashboard. Modelo de amenazas completo en la spec §13.

## Principios vigentes en el código

- El backend decide estados, permisos y límites; el modelo sólo propone (RN-006, RN-019).
- Las rutas se canonizan y se rechazan traversal, symlinks y junctions fuera de los roots (`@devpilot/security`).
- Sólo se ejecutan comandos de una allowlist, como argv tipado y sin shell.
- Las aprobaciones están ligadas a run, acción y hash del diff, caducan y son de un solo uso.
- Los secretos se redactan antes de llegar a logs, eventos o errores.
- Ninguna API de pago se usa sin `ENABLE_PAID_APIS=true` **y** consentimiento por proveedor.

## Limitaciones conocidas

- Sin sandbox de proceso todavía: Nivel 1 (§13.1) sólo está diseñado. Para repositorios no confiables hará falta contenedor o VM.
- La redacción es por patrones: reduce la fuga, no la garantiza.
- La validación de paths tiene una ventana TOCTOU inherente; hay que revalidar justo antes de operar.

## Reporte

Proyecto personal sin servicio expuesto. Reportar vulnerabilidades abriendo un issue privado en el repositorio.
