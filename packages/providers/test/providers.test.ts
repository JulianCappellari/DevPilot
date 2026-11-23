import { describe, expect, it } from "vitest";
import { MockProvider, type AgentEvent, type AgentRequest } from "../src/index.js";

const req: AgentRequest = {
  runId: "r1", projectId: "p1", worktreePath: "/wt", task: "t", acceptanceCriteria: ["x"],
  policy: { readOnly: true, timeoutMs: 1000 }, contextRefs: [],
};
const collect = async (it: AsyncIterable<AgentEvent>) => {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("MockProvider", () => {
  it("declara costo LOCAL y sin escritura de código", async () => {
    const p = new MockProvider();
    expect(await p.capabilities()).toMatchObject({ costOrigin: "LOCAL", canWriteCode: false });
    expect(await p.health()).toEqual({ available: true });
  });
  it("emite started, progress*N y completed de forma determinista", async () => {
    const ev = await collect(new MockProvider({ steps: 2 }).execute(req, new AbortController().signal));
    expect(ev.map((e) => e.type)).toEqual(["started", "progress", "progress", "completed"]);
  });
  it("emite error sintético en el paso configurado, sin 'completed'", async () => {
    const ev = await collect(new MockProvider({ failAt: 2 }).execute(req, new AbortController().signal));
    expect(ev.at(-1)).toMatchObject({ type: "error" });
    expect(ev.some((e) => e.type === "completed")).toBe(false);
  });
  it("respeta la cancelación vía AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort();
    const ev = await collect(new MockProvider().execute(req, ac.signal));
    expect(ev.map((e) => e.type)).toEqual(["started", "error"]);
  });
});
