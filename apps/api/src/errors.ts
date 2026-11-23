import { InvalidTransitionError, VersionConflictError } from "@devpilot/domain";
import { HTTP_STATUS, type ErrorCode } from "@devpilot/contracts";
import { CommandDeniedError, PathPolicyError } from "@devpilot/security";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly auditDenied = false) {
    super(message);
    this.name = "AppError";
  }
}

/** Mapea cualquier error a {status, code, message} sin filtrar rutas, SQL ni trazas (spec §10.2). */
export function toHttpError(e: unknown): { status: number; code: ErrorCode | "INTERNAL"; message: string } {
  if (e instanceof AppError) return { status: HTTP_STATUS[e.code], code: e.code, message: e.message };
  if (e instanceof ZodError) return { status: 400, code: "VALIDATION", message: "Datos inválidos: " + e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ") };
  if (e instanceof VersionConflictError) return { status: 409, code: "VERSION_CONFLICT", message: "El recurso cambió; recargá y reintentá" };
  if (e instanceof InvalidTransitionError) return { status: 422, code: "INVALID_STATE", message: e.message };
  if (e instanceof PathPolicyError) {
    if (e.code === "OUTSIDE_ROOT") return { status: 403, code: "FORBIDDEN", message: e.message };
    return { status: e.code === "NOT_FOUND" ? 404 : 400, code: e.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION", message: e.message };
  }
  if (e instanceof CommandDeniedError) return { status: 403, code: "FORBIDDEN", message: e.message };
  return { status: 500, code: "INTERNAL", message: "Error interno" };
}
