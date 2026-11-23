import { createHash } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { containsSecret, isSensitivePath, resolveInsideRoot } from "@devpilot/security";
import type { AgentEvent, AgentProvider, AgentRequest, Capabilities, Health } from "./index.js";

export const MARKDOWN_LIMIT = 64 * 1024;
export const markdownSha = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");
export const markdownWorktreeSha = (content: string): string => markdownSha(content.replace(/\r\n/g, "\n"));
export type MarkdownEdit = { path: string; sha256: string; content: string };

export function markdownPath(relative: string): string {
  if (!relative.toLowerCase().endsWith(".md") || path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split("/").some((part) => !part || part.startsWith(".") || /[<>:"|?*\\]/.test(part) || /[. ]$/.test(part) ||
        [...part].some((char) => char.charCodeAt(0) < 32)) ||
      isSensitivePath(relative)) throw new Error("Usá la ruta relativa de un archivo Markdown dentro del repositorio");
  return relative;
}

export async function readMarkdown(repo: string, relative: string) {
  const file = path.join(repo, markdownPath(relative));
  const resolved = await resolveInsideRoot(repo, file);
  if (!(await lstat(file)).isFile()) throw new Error("El contexto requiere un archivo Markdown regular");
  const handle = await open(resolved, "r");
  try {
    const buffer = Buffer.alloc(MARKDOWN_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MARKDOWN_LIMIT) throw new Error("El archivo Markdown supera 64 KiB");
    const bytes = buffer.subarray(0, size);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes("\0") || containsSecret(content)) throw new Error("El archivo contiene datos binarios o sensibles");
    return { file: resolved, content, sha256: markdownSha(bytes) };
  } finally { await handle.close(); }
}

export class MarkdownProvider implements AgentProvider {
  readonly id = "context-markdown";

  async capabilities(): Promise<Capabilities> {
    return { id: this.id, costOrigin: "LOCAL", canWriteCode: true };
  }

  async health(): Promise<Health> { return { available: true }; }

  async *execute(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const edit = request.markdownEdit;
    if (!edit || request.policy.readOnly || signal.aborted) {
      yield { type: "error", message: "No hay una propuesta Markdown autorizada" };
      return;
    }
    try {
      const original = await readMarkdown(request.worktreePath, edit.path);
      if (markdownWorktreeSha(original.content) !== edit.sha256) throw new Error("El archivo cambió desde la propuesta; actualizá el contexto y volvé a proponer");
      signal.throwIfAborted();
      await writeFile(original.file, edit.content, "utf8");
      yield { type: "file_changed", path: edit.path, change: "modified" };
      yield { type: "completed" };
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : "No se pudo preparar el diff Markdown" };
    }
  }
}
