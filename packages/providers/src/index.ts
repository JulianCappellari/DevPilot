import type { CostOrigin } from "@devpilot/domain";
import { OllamaProvider, safeTargetPath } from "./ollama.js";
import { CodexProvider, type CodexMode } from "./codex.js";
import { MarkdownProvider, type MarkdownEdit } from "./markdown.js";

export * from "./ollama.js";
export * from "./codex.js";
export * from "./markdown.js";

/** Contrato de proveedor (spec §8.4). El dominio no depende de formatos propietarios de SDK. */
export type Capabilities = { id: string; costOrigin: CostOrigin; canWriteCode: boolean };
export type Health = { available: boolean; detail?: string };

export type ExecutionPolicy = { readOnly: boolean; timeoutMs: number };
export type AgentRequest = {
  runId: string; projectId: string; worktreePath: string;
  task: string; acceptanceCriteria: string[];
  policy: ExecutionPolicy; contextRefs: string[];
  markdownEdit?: MarkdownEdit;
};

export type AgentEvent =
  | { type: "started"; runId: string }
  | { type: "progress"; message: string }
  | { type: "file_changed"; path: string; change: "added" | "modified" | "deleted" }
  | { type: "tool_request"; tool: string }
  | { type: "tool_result"; tool: string; ok: boolean }
  | { type: "message"; text: string }
  | { type: "completed" }
  | { type: "error"; message: string };

export interface AgentProvider {
  readonly id: string;
  capabilities(): Promise<Capabilities>;
  health(): Promise<Health>;
  execute(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/**
 * Proveedor de demostración que sí escribe: crea un archivo de notas dentro del worktree.
 * Permite ejercitar worktree -> checks -> diff -> revisión sin ningún agente real. Costo 0.
 */
export class DemoWriterProvider implements AgentProvider {
  readonly id = "mock-writer";
  capabilities(): Promise<Capabilities> {
    return Promise.resolve({ id: this.id, costOrigin: "LOCAL", canWriteCode: true });
  }
  health(): Promise<Health> {
    return Promise.resolve({ available: true });
  }
  async *execute(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: request.runId };
    if (signal.aborted) { yield { type: "error", message: "aborted" }; return; }
    yield { type: "progress", message: "Analizando la tarea" };
    const { writeFile } = await import("node:fs/promises");
    const rel = "devpilot-notes/" + request.runId + ".md";
    const body = ["# Notas de la ejecución", "", "Tarea: " + request.task, "", "## Criterios de aceptación", ...request.acceptanceCriteria.map((c) => "- " + c), ""].join("\n");
    await writeFile(await safeTargetPath(request.worktreePath, rel), body, { encoding: "utf8", flag: "wx" });
    yield { type: "file_changed", path: rel, change: "added" };
    yield { type: "progress", message: "Cambios escritos" };
    yield { type: "completed" };
  }
}

/** Proveedor determinista de eventos sintéticos: QA del orquestador, costo 0 (RF-009). */
export class MockProvider implements AgentProvider {
  readonly id = "mock";
  constructor(private readonly opts: { steps?: number; failAt?: number } = {}) {}

  capabilities(): Promise<Capabilities> {
    return Promise.resolve({ id: this.id, costOrigin: "LOCAL", canWriteCode: false });
  }
  health(): Promise<Health> {
    return Promise.resolve({ available: true });
  }

  async *execute(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const steps = this.opts.steps ?? 3;
    yield { type: "started", runId: request.runId };
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      if (this.opts.failAt === i) {
        yield { type: "error", message: `fallo sintético en paso ${i}` };
        return;
      }
      yield { type: "progress", message: `paso ${i}/${steps}` };
      await Promise.resolve();
    }
    yield { type: "completed" };
  }
}

/** Marcador de proveedor aún no integrado: nunca ejecuta y nunca simula éxito (spec §22.1). */
export class UnavailableProvider implements AgentProvider {
  constructor(readonly id: string, private readonly costOrigin: CostOrigin, private readonly reason: string) {}
  capabilities(): Promise<Capabilities> {
    return Promise.resolve({ id: this.id, costOrigin: this.costOrigin, canWriteCode: true });
  }
  health(): Promise<Health> {
    return Promise.resolve({ available: false, detail: this.reason });
  }
  // eslint-disable-next-line require-yield
  async *execute(): AsyncIterable<AgentEvent> {
    throw new Error(`Proveedor ${this.id} no disponible: ${this.reason}`);
  }
}

export function defaultProviders(ollama: { baseUrl: string; model: string } = { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" }, codexMode: CodexMode = "off"): Map<string, AgentProvider> {
  const list: AgentProvider[] = [
    new OllamaProvider(ollama),
    new MockProvider(),
    new DemoWriterProvider(),
    new MarkdownProvider(),
    new CodexProvider(codexMode),
  ];
  return new Map(list.map((p) => [p.id, p]));
}
