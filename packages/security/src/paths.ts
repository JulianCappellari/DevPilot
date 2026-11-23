import { realpath } from "node:fs/promises";
import path from "node:path";

export class PathPolicyError extends Error {
  constructor(readonly code: "INVALID_PATH" | "OUTSIDE_ROOT" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** true si `candidate` está dentro de `root` (o es igual). Ambos deben estar ya canonizados. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

const DEVICE_PREFIX = /^(?:\\\\[?.]\\|\/\/[?.]\/)/;

/**
 * Canoniza y valida (RNF-004, RN-016): rechaza bytes nulos, prefijos de dispositivo,
 * traversal y symlinks/junctions que escapan del root. Los mensajes no incluyen rutas
 * absolutas para no filtrar información (spec §10.2).
 * Nota TOCTOU: el llamador debe revalidar inmediatamente antes de operar sobre el FS.
 */
export async function resolveInsideRoot(root: string, candidate: string): Promise<string> {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || DEVICE_PREFIX.test(candidate))
    throw new PathPolicyError("INVALID_PATH", "Ruta inválida");
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new PathPolicyError("NOT_FOUND", "Root no disponible");
  }
  try {
    realCandidate = await realpath(path.resolve(candidate));
  } catch {
    throw new PathPolicyError("NOT_FOUND", "La ruta no existe");
  }
  if (!isInside(realRoot, realCandidate)) throw new PathPolicyError("OUTSIDE_ROOT", "Ruta fuera de las raíces autorizadas");
  return realCandidate;
}

/** Valida contra varias raíces autorizadas; devuelve el primer root que contiene la ruta. */
export async function resolveInsideAnyRoot(
  roots: readonly string[], candidate: string,
): Promise<{ root: string; resolved: string }> {
  let last = new PathPolicyError("OUTSIDE_ROOT", "Ruta fuera de las raíces autorizadas");
  for (const root of roots) {
    try {
      return { root, resolved: await resolveInsideRoot(root, candidate) };
    } catch (e) {
      if (e instanceof PathPolicyError) last = e;
      else throw e;
    }
  }
  throw last;
}
