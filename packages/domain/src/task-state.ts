/** Máquina de estados de tarea (spec §6.1, RN-019: el backend decide). */
export const TASK_STATES = [
  "DRAFT", "READY", "QUEUED", "RUNNING", "REVIEW_PENDING",
  "APPROVED", "REJECTED", "NEEDS_CHANGES",
  "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ["READY"],
  READY: ["QUEUED", "DRAFT"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["REVIEW_PENDING", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"],
  REVIEW_PENDING: ["APPROVED", "REJECTED", "NEEDS_CHANGES"],
  NEEDS_CHANGES: ["READY"], // nuevo intento; el anterior no se borra
  APPROVED: [],
  REJECTED: [],
  FAILED: ["READY"],
  TIMED_OUT: ["READY"],
  CANCELLED: ["READY"], // RN-012: nunca se reanuda; crea un nuevo intento
  UNKNOWN: ["READY", "FAILED"],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: string, readonly to: string, readonly kind: string) {
    super(`Transición inválida de ${kind}: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class VersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Conflicto de versión: esperada ${expected}, actual ${actual}`);
    this.name = "VersionConflictError";
  }
}

export const canTransitionTask = (from: TaskState, to: TaskState): boolean =>
  TRANSITIONS[from].includes(to);

export type Versioned<S extends string> = { readonly state: S; readonly version: number };

/** Compare-and-swap de versión + validación de transición. Devuelve el nuevo valor (inmutable). */
export function transitionTask<T extends Versioned<TaskState>>(
  current: T, to: TaskState, expectedVersion: number,
): T {
  if (current.version !== expectedVersion) throw new VersionConflictError(expectedVersion, current.version);
  if (!canTransitionTask(current.state, to)) throw new InvalidTransitionError(current.state, to, "tarea");
  return { ...current, state: to, version: current.version + 1 };
}
