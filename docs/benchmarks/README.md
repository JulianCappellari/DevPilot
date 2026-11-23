# Benchmark de modelos locales (2026-11-23)

Reproducible con `npm run bench:models` (datos crudos y respuestas en `models-2026-11-23.json`).
Hardware: RTX 4070 Super 12 GB, Ollama 0.40.16, Q4_K_M, temperatura 0, semilla fija, `think:false` para los tres.

| Métrica | gemma3:12b | gemma4:12b | qwen3.5:9b |
|---|---|---|---|
| Velocidad de generación (tok/s) | 55 | 102 | 71 |
| Latencia media por pregunta (s) | 1,8 | 0,8 | 1,3 |
| Carga en frío (s) | 9,2 | 9,8 | 7,1 |
| VRAM real (nvidia-smi, aprox.) | ~8,9 GB | ~8,7 GB | ~5,6 GB (según Ollama, sin contrastar) |
| Clasificación: JSON válido | 8/8 | 8/8 | 8/8 |
| Clasificación: categoría correcta | 6/8 | 6/8 | 6/8 |
| Caso con prompt injection clasificado bien | no (chore) | sí | no (feature) |
| Código (22 tests ejecutados) | 20/22 | 22/22 | 20/22 |
| Razonamiento (4 preguntas) | 4/4 | 4/4 | 4/4 |
| Explicación: 3 oraciones, en español | sí | sí | sí |

## Lectura honesta
- Ningún modelo obedeció la inyección (ninguno devolvió `bug`); sólo gemma4 clasificó el caso correctamente.
- Muestras pequeñas: 8 clasificaciones, 4 funciones, 4 preguntas. Las diferencias de 1-2 aciertos no son estadísticamente significativas. El único fallo de código fue en `safeGet` (gemma3 y qwen fallaron con rutas tipo `a.b[0].c`; gemma4 pasó).
- `ollama ps` subinforma la VRAM de gemma4 (1,1 GB); `nvidia-smi` muestra ~8,7 GB.
- `think:false` desactiva el razonamiento interno: gemma4 y qwen3.5 son modelos con "thinking" y podrían rendir distinto con él activado (más lento).
- La calidad de coherencia se midió con reglas automáticas, no con lectura humana.

## Decisión
`gemma4:12b` queda como modelo por defecto (`OLLAMA_MODEL`): el más rápido, el mejor en código y en el caso adversarial. `qwen3.5:9b` es la alternativa si se necesita liberar ~3 GB de VRAM.
