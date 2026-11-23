import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { MarkdownProvider, markdownPath, markdownSha, readMarkdown, type AgentEvent, type AgentRequest } from "../src/index.js";

it.each(["../file.md", "/file.md", "C:\\file.md", "a//x.md", "a\n.md", "folder/x .md/..", "a|x.md", ".git/x.md", "x.txt", "a./x.md"])("rechaza una ruta Markdown inválida: %j", (file) => {
  expect(() => markdownPath(file)).toThrow();
});

it("valida bytes, tipo de archivo y huella del Markdown antes de preparar el cambio", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "devpilot-md-")));
  const provider = new MarkdownProvider();
  const file = path.join(dir, "notes.md");
  const request: AgentRequest = {
    runId: "run_test", projectId: "fixture", worktreePath: dir, task: "Actualizar notas", acceptanceCriteria: [],
    policy: { readOnly: false, timeoutMs: 5000 }, contextRefs: [],
  };
  const ac = new AbortController();
  const execute = async (overrides: Partial<AgentRequest> = {}) => {
    const events: AgentEvent[] = [];
    for await (const event of provider.execute({ ...request, ...overrides }, ac.signal)) events.push(event);
    return events;
  };
  try {
    await expect(readMarkdown(dir, "notes.md")).rejects.toThrow();
    mkdirSync(path.join(dir, "folder.md"));
    await expect(readMarkdown(dir, "folder.md")).rejects.toThrow(/regular/);
    writeFileSync(file, "x".repeat(65_537));
    await expect(readMarkdown(dir, "notes.md")).rejects.toThrow(/64 KiB/);
    writeFileSync(file, "a\0b");
    await expect(readMarkdown(dir, "notes.md")).rejects.toThrow(/binarios/);
    writeFileSync(file, "password=ejemplo-ficticio");
    await expect(readMarkdown(dir, "notes.md")).rejects.toThrow(/sensibles/);
    writeFileSync(file, "versión uno\n");
    const original = await readMarkdown(dir, "notes.md");
    expect(original.sha256).toBe(markdownSha("versión uno\n"));
    const edit = { path: "notes.md", sha256: original.sha256, content: "versión dos\n" };
    expect(await execute()).toMatchObject([{ type: "error" }]);
    expect(await execute({ markdownEdit: edit, policy: { readOnly: true, timeoutMs: 1000 } })).toMatchObject([{ type: "error" }]);
    expect(await execute({ markdownEdit: { ...edit, sha256: "desactualizado" } })).toMatchObject([{ type: "error" }]);
    expect(await execute({ markdownEdit: edit })).toEqual([{ type: "file_changed", path: "notes.md", change: "modified" }, { type: "completed" }]);
    expect(readFileSync(file, "utf8")).toBe(edit.content);
    expect(await provider.health()).toEqual({ available: true });
    expect(await provider.capabilities()).toMatchObject({ costOrigin: "LOCAL", canWriteCode: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
