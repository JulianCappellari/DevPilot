# Interfaz de DevPilot

DevPilot es una herramienta de trabajo (modo *operate*): la interfaz prioriza lectura rápida, estados inequívocos y acciones de aprobación claras. El movimiento comunica estado y nunca decora.

## Estructura

| Ruta | Función |
|---|---|
| `apps/web/public/styles.css` | Tokens (color OKLCH, tipografía, espaciado, movimiento), tema claro y oscuro, componentes |
| `apps/web/public/app.js` | SPA sin build, shell persistente, páginas, router |
| `apps/web/public/ui/icons.js` | Iconos SVG de trazo (conjunto Lucide, ISC) para estados, navegación y acciones |
| `apps/web/public/ui/motion.js` | Entradas, salidas y pulso de estado con Motion; respeta `prefers-reduced-motion` |
| `apps/web/public/ui/theme-init.js` | Aplica el tema elegido antes del primer render |
| `apps/web/public/vendor`, `fonts` | Librerías y tipografías servidas localmente (CSP `'self'`) |
| `scripts/vendor-ui.mjs` | `npm run vendor:ui` regenera `vendor/` y `fonts/` desde `node_modules` |
| `scripts/preview-ui.ts` | Instancia descartable con un repo de demostración para revisar la UI a mano |

## Decisiones sobre librerías

La CSP (`script-src 'self'`, `style-src 'self'`) impide CDN y estilos en línea. Todo se empaqueta como archivo local y se cachea en el service worker.

| Librería | Decisión | Motivo |
|---|---|---|
| Motion (`motion/mini`, MIT) | Usada (8,6 KB) | Toasts, diálogos y pulso de estado en vivo sobre WAAPI |
| View Transitions API | Usada | Fundido de 150 ms entre rutas, sin dependencias; se omite con movimiento reducido |
| Inter y JetBrains Mono (OFL) | Usadas, autoalojadas | Lectura de datos con cifras tabulares; sin peticiones externas |
| Lucide (ISC) | Trazados copiados | Iconos coherentes sin un bundle de 1 000 iconos |
| GSAP, ScrollTrigger, Lenis | No usadas | El scroll suave y las secuencias por scroll perjudican la lectura de diffs y logs |
| Three.js, R3F, Spline, Rive, Lottie | No usadas | Sin función en un panel operativo; costo de bundle injustificado |
| React Bits, Aceternity, Magic UI, shadcn | No usadas | Requieren React y Tailwind; reescribir la UI y el build no aporta al producto |

Los tres grupos de Landing, Portfolio y E-commerce de las referencias no aplican a esta superficie.

## Sistema de diseño

- Neutros teñidos hacia el azul de la marca, un único acento (`--accent`) para acción primaria, selección y foco. Verde, ámbar y rojo sólo expresan estado.
- Escala tipográfica fija (0,75 a 1,625 rem) y una familia. Números con `tabular-nums`.
- Cada estado combina icono, color y texto: el color nunca es el único canal.
- Movimiento de 120 a 250 ms con curva exponencial. Esqueleto de carga sólo si la respuesta tarda más de 150 ms y cambia la ruta.
- Responsive estructural: la barra lateral pasa a barra inferior con seis destinos por debajo de 760 px; objetivos táctiles de 44 px.

## Verificación

`npm run test:browser` recorre el flujo de ejecución, la revisión manual, Informes y GitHub con un doble de la API. También comprueba la PWA móvil y usa axe en los temas claro y oscuro.

Las licencias de las tipografías, los iconos y Motion están en [docs/licenses](../licenses/).
