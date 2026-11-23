import { InvalidTransitionError, VersionConflictError, type Versioned } from "./task-state.js";

/** Estado independiente de cada ejecución (RF-019, RN-011: timeout/cancelación ≠ fallo). */
export const RUN_STATES = [
  "PENDING_APPROVAL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED",
  "CANCELLED", "TIMED_OUT", "PARTIAL", "UNKNOWN", "BLOCKED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  PENDING_APPROVAL: ["QUEUED", "CANCELLED", "BLOCKED"],
  QUEUED: ["RUNNING", "CANCELLED", "BLOCKED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "PARTIAL", "UNKNOWN"],
  UNKNOWN: ["FAILED", "CANCELLED"], // reconciliación tras reinicio (CU-11)
  SUCCEEDED: [], FAILED: [], CANCELLED: [], TIMED_OUT: [], PARTIAL: [], BLOCKED: [],
};

const TERMINAL: ReadonlySet<RunState> = new Set(
  RUN_STATES.filter((s) => TRANSITIONS[s].length === 0),
);

export const isTerminalRun = (s: RunState): boolean => TERMINAL.has(s);
export const canTransitionRun = (from: RunState, to: RunState): boolean => TRANSITIONS[from].includes(to);

export function transitionRun<T extends Versioned<RunState>>(current: T, to: RunState, expectedVersion: number): T {
  if (current.version !== expectedVersion) throw new VersionConflictError(expectedVersion, current.version);
  if (!canTransitionRun(current.state, to)) throw new InvalidTransitionError(current.state, to, "run");
  return { ...current, state: to, version: current.version + 1 };
}

/** Carrera cancelación vs. finalización: gana la primera transición terminal aplicada (CU-05). */
export function cancelRun<T extends Versioned<RunState>>(current: T): T {
  if (isTerminalRun(current.state)) return current; // ya terminó: la cancelación no reescribe la historia
  return transitionRun(current, "CANCELLED", current.version);
}

/** Tras reinicio, un RUNNING sin proceso verificable pasa a UNKNOWN, nunca a éxito (RNF-009). */
export function reconcileAfterRestart<T extends Versioned<RunState>>(current: T, processAlive: boolean): T {
  if (current.state !== "RUNNING" || processAlive) return current;
  return transitionRun(current, "UNKNOWN", current.version);
}
