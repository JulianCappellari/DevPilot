import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError, RUN_STATES, TASK_STATES, VersionConflictError, canMarkQaPassed, canRequestExecution,
  canTransitionRun, canTransitionTask, canUseProvider, cancelRun, consumeApproval, deriveCheckState,
  isTerminalRun, parsePaidApisFlag, reconcileAfterRestart, transitionRun, transitionTask, validateApproval,
  type Approval, type RunState, type TaskState,
} from "../src/index.js";

describe("task state machine (spec §6.1)", () => {
  const t = (state: TaskState, version = 1) => ({ id: "t1", state, version });

  it("sigue el camino feliz DRAFT -> ... -> APPROVED incrementando versión", () => {
    let cur = t("DRAFT");
    for (const next of ["READY", "QUEUED", "RUNNING", "REVIEW_PENDING", "APPROVED"] as const) {
      cur = transitionTask(cur, next, cur.version);
    }
    expect(cur).toEqual({ id: "t1", state: "APPROVED", version: 6 });
  });
  it("rechaza saltos de etapa", () => {
    expect(() => transitionTask(t("DRAFT"), "RUNNING", 1)).toThrow(InvalidTransitionError);
    expect(() => transitionTask(t("READY"), "APPROVED", 1)).toThrow(InvalidTransitionError);
  });
  it("detecta conflicto de versión (compare-and-swap)", () => {
    expect(() => transitionTask(t("DRAFT", 3), "READY", 2)).toThrow(VersionConflictError);
  });
  it("APPROVED y REJECTED son terminales; CANCELLED sólo vuelve a READY (RN-012)", () => {
    for (const s of TASK_STATES) {
      expect(canTransitionTask("APPROVED", s)).toBe(false);
      expect(canTransitionTask("REJECTED", s)).toBe(false);
    }
    expect(canTransitionTask("CANCELLED", "RUNNING")).toBe(false);
    expect(canTransitionTask("CANCELLED", "READY")).toBe(true);
    expect(canTransitionTask("NEEDS_CHANGES", "READY")).toBe(true);
  });
  it("no muta el objeto original", () => {
    const orig = t("DRAFT");
    transitionTask(orig, "READY", 1);
    expect(orig.state).toBe("DRAFT");
  });
});

describe("run state machine", () => {
  const r = (state: RunState, version = 1) => ({ state, version });

  it("timeout y cancelación son estados distintos de FAILED (RN-011)", () => {
    expect(transitionRun(r("RUNNING"), "TIMED_OUT", 1).state).toBe("TIMED_OUT");
    expect(transitionRun(r("RUNNING"), "CANCELLED", 1).state).toBe("CANCELLED");
  });
  it("los estados terminales no admiten transición", () => {
    for (const s of RUN_STATES.filter(isTerminalRun)) {
      for (const to of RUN_STATES) expect(canTransitionRun(s, to)).toBe(false);
    }
  });
  it("rechaza transición inválida y versión desactualizada", () => {
    expect(() => transitionRun(r("QUEUED"), "SUCCEEDED", 1)).toThrow(InvalidTransitionError);
    expect(() => transitionRun(r("QUEUED", 2), "RUNNING", 1)).toThrow(VersionConflictError);
  });
  it("cancelar un run ya terminado no reescribe el resultado (carrera CU-05)", () => {
    const done = r("SUCCEEDED", 5);
    expect(cancelRun(done)).toBe(done);
    expect(cancelRun(r("RUNNING")).state).toBe("CANCELLED");
  });
  it("reinicio: RUNNING sin proceso -> UNKNOWN, nunca éxito (T-006)", () => {
    expect(reconcileAfterRestart(r("RUNNING"), false).state).toBe("UNKNOWN");
    expect(reconcileAfterRestart(r("RUNNING"), true).state).toBe("RUNNING");
    expect(reconcileAfterRestart(r("QUEUED"), false).state).toBe("QUEUED");
  });
});

describe("políticas de ejecución y costos", () => {
  it("T-003: sin criterios de aceptación no se ejecuta", () => {
    expect(canRequestExecution({ projectStatus: "ACTIVE", acceptanceCriteria: [], scopeDefined: true })).toMatchObject({ ok: false, code: "MISSING_SCOPE_OR_AC" });
    expect(canRequestExecution({ projectStatus: "ACTIVE", acceptanceCriteria: ["  "], scopeDefined: true })).toMatchObject({ ok: false });
    expect(canRequestExecution({ projectStatus: "ACTIVE", acceptanceCriteria: ["x"], scopeDefined: false })).toMatchObject({ ok: false });
  });
  it("RN-002: proyecto archivado no recibe ejecuciones", () => {
    expect(canRequestExecution({ projectStatus: "ARCHIVED", acceptanceCriteria: ["x"], scopeDefined: true })).toMatchObject({ ok: false, code: "PROJECT_NOT_ACTIVE" });
    expect(canRequestExecution({ projectStatus: "ACTIVE", acceptanceCriteria: ["x"], scopeDefined: true })).toEqual({ ok: true });
  });
  it("T-012: API paga bloqueada por defecto y sin consentimiento", () => {
    const off = { enablePaidApis: false, paidProviderConsent: new Set(["x"]) };
    expect(canUseProvider("PAID_API", "x", off)).toMatchObject({ ok: false, code: "PAID_APIS_DISABLED" });
    const noConsent = { enablePaidApis: true, paidProviderConsent: new Set<string>() };
    expect(canUseProvider("PAID_API", "x", noConsent)).toMatchObject({ ok: false, code: "NO_CONSENT" });
    expect(canUseProvider("PAID_API", "x", { enablePaidApis: true, paidProviderConsent: new Set(["x"]) })).toEqual({ ok: true });
    expect(canUseProvider("LOCAL", "ollama", off)).toEqual({ ok: true });
    expect(canUseProvider("SUBSCRIPTION_QUOTA", "codex", off)).toEqual({ ok: true });
  });
  it("el flag de APIs pagas sólo se habilita con el literal 'true'", () => {
    expect(parsePaidApisFlag(undefined)).toBe(false);
    expect(parsePaidApisFlag("TRUE")).toBe(false);
    expect(parsePaidApisFlag("1")).toBe(false);
    expect(parsePaidApisFlag("true")).toBe(true);
  });
});

describe("aprobaciones (RN-020, T-010)", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  const base: Approval = {
    id: "a1", runId: "r1", action: "accept_diff", diffHash: "h1",
    expiresAt: new Date("2026-11-23T12:05:00Z"), decision: "APPROVED", consumedAt: null,
  };
  const chk = { runId: "r1", action: "accept_diff", currentDiffHash: "h1", now };

  it("acepta una aprobación vigente y coincidente", () => {
    expect(validateApproval(base, chk)).toEqual({ ok: true });
  });
  it("invalida si cambia el diff", () => {
    expect(validateApproval(base, { ...chk, currentDiffHash: "h2" })).toEqual({ ok: false, reason: "DIFF_CHANGED" });
  });
  it("invalida si venció (incluido el instante exacto)", () => {
    expect(validateApproval(base, { ...chk, now: new Date("2026-11-23T12:05:00Z") })).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("una aprobación de revisar diff no autoriza otra acción ni otro run", () => {
    expect(validateApproval(base, { ...chk, action: "push" })).toEqual({ ok: false, reason: "WRONG_ACTION" });
    expect(validateApproval(base, { ...chk, runId: "r2" })).toEqual({ ok: false, reason: "WRONG_RUN" });
  });
  it("no se puede reutilizar (anti-replay) ni usar si no está APPROVED", () => {
    expect(validateApproval(consumeApproval(base, now), chk)).toEqual({ ok: false, reason: "ALREADY_USED" });
    for (const decision of ["PENDING", "REJECTED", "REVOKED"] as const)
      expect(validateApproval({ ...base, decision }, chk)).toEqual({ ok: false, reason: "NOT_APPROVED" });
  });
});

describe("resultado de QA (RN-010, T-009)", () => {
  it("deriva de código de salida real", () => {
    expect(deriveCheckState({ exitCode: 0, timedOut: false })).toBe("PASSED");
    expect(deriveCheckState({ exitCode: 1, timedOut: false })).toBe("FAILED");
    expect(deriveCheckState({ exitCode: 0, timedOut: true })).toBe("TIMED_OUT");
    expect(deriveCheckState({ exitCode: null, timedOut: false })).toBe("UNKNOWN");
    expect(deriveCheckState({ exitCode: 1.5, timedOut: false })).toBe("UNKNOWN");
    expect(deriveCheckState(undefined)).toBe("UNKNOWN");
  });
  it("sin evidencia no hay 'aprobado'", () => {
    expect(canMarkQaPassed([])).toBe(false);
    expect(canMarkQaPassed(["PASSED", "UNKNOWN"])).toBe(false);
    expect(canMarkQaPassed(["PASSED", "FAILED"])).toBe(false);
    expect(canMarkQaPassed(["PASSED", "PASSED"])).toBe(true);
  });
});
