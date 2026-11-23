import { expect, it } from "vitest";
import { CodexProvider, decodeCodexEvent, type AgentEvent } from "../src/index.js";
import type { RunOptions, RunResult } from "@devpilot/runner";

const ok: RunResult = { exitCode: 0, timedOut: false, cancelled: false, stdout: "", stderr: "", durationMs: 2 };
const probe = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"DEVPILOT_PROBE_OK"}}';

it("traduce el JSONL validado de Codex y exige el fin del turno y del proceso", async () => {
  const calls: RunOptions[] = [];
  const provider = new CodexProvider("write", async (opts) => {
    calls.push(opts);
    if (opts.args[0] === "login") return { ...ok, stderr: "Logged in using ChatGPT" };
    for (const line of ['{"type":"turn.started"}', probe, '{"type":"turn.completed"}']) opts.onStdoutLine?.(line);
    return ok;
  });
  expect(await provider.health()).toEqual({ available: true });
  const output: AgentEvent[] = [];
  for await (const event of provider.execute({
    runId: "run_example", projectId: "project_example", worktreePath: process.cwd(), task: "Prueba",
    acceptanceCriteria: ["OK"], policy: { readOnly: true, timeoutMs: 2000 }, contextRefs: [],
  }, new AbortController().signal)) output.push(event);
  expect(output.map((event) => event.type)).toEqual(["started", "progress", "message", "completed"]);
  expect(calls[1]?.args).toEqual(expect.arrayContaining(['permissions.devpilot.extends=":read-only"', "--ignore-user-config", "--json", "permissions.devpilot.network.enabled=false"]));
  expect(calls[1]?.input).toContain("Prueba");
  expect(await new CodexProvider("off").health()).toMatchObject({ available: false });
  expect(await new CodexProvider("write", async () => ({ ...ok, exitCode: 1 })).health()).toMatchObject({ available: false });
  expect(decodeCodexEvent("no JSON")).toBeUndefined();
  expect(decodeCodexEvent('{"type":"turn.failed"}')?.type).toBe("error");
});
