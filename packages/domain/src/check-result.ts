/** RN-010 / RF-025 / RNF-012: el resultado deriva de código de salida real, nunca de afirmaciones. */
export type CheckState = "PASSED" | "FAILED" | "TIMED_OUT" | "UNKNOWN";
export type CheckEvidence = { exitCode: number | null; timedOut: boolean };

export function deriveCheckState(e: CheckEvidence | undefined): CheckState {
  if (!e) return "UNKNOWN";
  if (e.timedOut) return "TIMED_OUT";
  if (e.exitCode === null || !Number.isInteger(e.exitCode)) return "UNKNOWN";
  return e.exitCode === 0 ? "PASSED" : "FAILED";
}

/** Sólo se puede declarar "aprobado" si hay al menos un check y todos pasaron con evidencia. */
export function canMarkQaPassed(states: readonly CheckState[]): boolean {
  return states.length > 0 && states.every((s) => s === "PASSED");
}
