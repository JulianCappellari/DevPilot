/** Reglas de negocio de ejecución y costos (RN-002, RN-005, RN-007, RF-027, RNF-024). */
export type ProjectStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";
export type CostOrigin = "LOCAL" | "SUBSCRIPTION_QUOTA" | "PAID_API";

export type ExecutionCheckInput = {
  projectStatus: ProjectStatus;
  acceptanceCriteria: readonly string[];
  scopeDefined: boolean;
};

export type PolicyResult = { ok: true } | { ok: false; code: string; reason: string };

export function canRequestExecution(i: ExecutionCheckInput): PolicyResult {
  if (i.projectStatus !== "ACTIVE")
    return { ok: false, code: "PROJECT_NOT_ACTIVE", reason: "El proyecto no está activo (RN-002)" };
  if (!i.scopeDefined || i.acceptanceCriteria.filter((c) => c.trim().length > 0).length === 0)
    return { ok: false, code: "MISSING_SCOPE_OR_AC", reason: "Falta alcance o criterios de aceptación (RN-005)" };
  return { ok: true };
}

export type CostConfig = { enablePaidApis: boolean; paidProviderConsent: ReadonlySet<string> };

/** RN-007: ninguna API paga se invoca sin flag global y consentimiento explícito por proveedor. */
export function canUseProvider(origin: CostOrigin, providerId: string, cfg: CostConfig): PolicyResult {
  if (origin !== "PAID_API") return { ok: true };
  if (!cfg.enablePaidApis)
    return { ok: false, code: "PAID_APIS_DISABLED", reason: "ENABLE_PAID_APIS=false" };
  if (!cfg.paidProviderConsent.has(providerId))
    return { ok: false, code: "NO_CONSENT", reason: `Sin consentimiento explícito para ${providerId}` };
  return { ok: true };
}

/** Parseo estricto: sólo el literal "true" habilita; cualquier otro valor mantiene el default seguro. */
export const parsePaidApisFlag = (v: string | undefined): boolean => v === "true";
