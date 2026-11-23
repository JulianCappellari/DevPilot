# Carga, corte y restauración

## Simulacro automatizado

Ejecutá `npm run test:operations`. El programa crea un directorio de datos y un repo sintético, registra el proyecto, somete el dashboard a carga y corta únicamente el proceso de DevPilot que inició la prueba. Después reinicia la API, crea una copia y la restaura en otro directorio.

El 23 de noviembre de 2026, en Windows con un Intel Core i7-13700F, el primer recorrido procesó 66.210 solicitudes al dashboard en 20 segundos con diez clientes concurrentes. El p95 fue **4,25 ms** frente a la meta de 500 ms. Tras el corte, la ejecución y la tarea aparecieron como `UNKNOWN`. La copia restaurada conservó ambos estados y el evento de auditoría.

Una segunda ejecución concurrente con la suite de navegador procesó 39.035 solicitudes y obtuvo un p95 de **9,25 ms**. El recorrido también confirmó que una API con worker embebido deshabilitado deja el job en cola hasta que arranca el proceso separado. El worker ejecutó una tarea real con Codex sobre un repo sintético y entregó el commit tras pasar QA y revisión.

Con la implementación completa de DP-SPEC-001, el mismo simulacro procesó 54.248 solicitudes en 20 segundos con un p95 de **4,61 ms**. Volvieron a pasar el corte, la restauración y el flujo de Codex con el worker separado.

## Simulacro con una copia propia

1. Con la app en funcionamiento ejecutá `npm run backup` y anotá la ruta de la copia.
2. Elegí una carpeta nueva para el simulacro. En una terminal de PowerShell, configurá `$env:DATA_DIR` con esa ruta y ejecutá `npm run restore -- "<ruta de la copia>"`.
3. Antes de arrancar la app sobre esa copia, configurá `$env:EMBEDDED_WORKER='false'` para evitar que se ejecuten jobs de la base restaurada. Elegí un puerto local libre. Si la copia proviene de una app con cookies seguras detrás de HTTPS, configurá `$env:COOKIE_SECURE='false'` sólo para el simulacro por HTTP de loopback.
4. Ejecutá `npm start`. Ingresá y comprobá que podés consultar las tareas, ejecuciones y auditoría esperadas. Detené la instancia de prueba al terminar.

## Reemplazo de la base en uso

Detené la API y el worker que comparten `DATA_DIR`. Ejecutá `npm run restore -- "<ruta de la copia>"` con la configuración habitual y reiniciá. La base anterior queda como `devpilot.db.bak` en el directorio de datos. Si necesitás volver a ella, guardá ese archivo con otro nombre y restaurá esa copia mediante el mismo comando.
