import type { FastifyInstance } from "fastify";
import { ok } from "@devpilot/contracts";
import { MARKDOWN_LIMIT, markdownPath, markdownWorktreeSha, readMarkdown } from "@devpilot/providers";
import { containsSecret } from "@devpilot/security";
import { all, audit, get, getProject, newId, nowIso, run, tx, type ProjectRow } from "@devpilot/storage";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { summarizeLocally } from "./classify.js";
import { AppError } from "./errors.js";

type ContextFile = { id: string; project_id: string; path: string; sha256: string; version: number };
const id = z.string().min(1).max(64);
const ids = z.object({ id, fileId: id });
const version = z.number().int().positive();
const view = (row: ContextFile) => ({ id: row.id, path: row.path, sha256: row.sha256, version: row.version });

async function read(repo: string, relative: string) {
  try { return await readMarkdown(repo, relative); }
  catch { throw new AppError("VALIDATION", "Revisá que la ruta corresponda a un Markdown regular, UTF-8 y sin secretos, de hasta 64 KiB"); }
}

export function registerContextRoutes(app: FastifyInstance, { db, config }: AppDeps, prefix: string, authorizedRepo: (p: ProjectRow) => Promise<string>) {
  const base = `${prefix}/projects/:id/context`;
  async function repo(projectId: string) {
    const project = getProject(db, projectId);
    if (!project) throw new AppError("NOT_FOUND", "Proyecto no encontrado");
    return authorizedRepo(project);
  }
  function getFile(projectId: string, fileId: string): ContextFile {
    const row = get<ContextFile>(db, "SELECT * FROM context_file WHERE project_id=? AND id=?", projectId, fileId);
    if (!row) throw new AppError("NOT_FOUND", "Archivo de contexto no encontrado");
    return row;
  }
  app.get(base, async (req) => {
    const projectId = z.object({ id }).parse(req.params).id;
    await repo(projectId);
    return ok(all<ContextFile>(db, "SELECT * FROM context_file WHERE project_id=? ORDER BY path", projectId).map(view), req.id);
  });
  app.post(base, async (req) => {
    const projectId = z.object({ id }).parse(req.params).id;
    const input = z.object({ path: z.string().min(1).max(400), version: version.optional() }).strict().parse(req.body);
    const root = await repo(projectId);
    const current = await read(root, input.path);
    const relative = markdownPath(input.path);
    const now = nowIso();
    const row = tx(db, () => {
      const previous = get<ContextFile>(db, "SELECT * FROM context_file WHERE project_id=? AND path=?", projectId, relative);
      if (previous ? previous.version !== input.version : input.version !== undefined)
        throw new AppError("VERSION_CONFLICT", "El registro de contexto cambió; actualizá la vista");
      const fileId = previous?.id ?? newId("ctx");
      if (previous) run(db, "UPDATE context_file SET sha256=?,version=version+1,updated_at=? WHERE id=?", current.sha256, now, fileId);
      else run(db, "INSERT INTO context_file(id,project_id,path,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?)", fileId, projectId, relative, current.sha256, now, now);
      audit(db, { actorId: req.auth!.userId, action: "context.register", entityType: "context_file", entityId: fileId, outcome: "OK", detail: { sha256: current.sha256 }, correlationId: req.id });
      return getFile(projectId, fileId);
    });
    return ok(view(row), req.id);
  });
  app.get(`${base}/:fileId`, async (req) => {
    const p = ids.parse(req.params);
    const row = getFile(p.id, p.fileId);
    const current = await read(await repo(p.id), row.path);
    return ok({ ...view(row), content: current.content, currentSha256: current.sha256, changed: current.sha256 !== row.sha256 }, req.id);
  });
  app.post(`${base}/:fileId/summary`, async (req) => {
    const p = ids.parse(req.params);
    const row = getFile(p.id, p.fileId);
    const current = await read(await repo(p.id), row.path);
    const summary = await summarizeLocally(current.content, config);
    if (!summary) throw new AppError("PROVIDER_UNAVAILABLE", "Ollama no pudo generar un resumen válido del contexto");
    return ok({ ...summary, sha256: current.sha256, proposal: true }, req.id);
  });
  app.post(`${base}/:fileId/proposals`, async (req) => {
    const p = ids.parse(req.params);
    const row = getFile(p.id, p.fileId);
    const input = z.object({ version, content: z.string().max(MARKDOWN_LIMIT) }).strict().parse(req.body);
    if (Buffer.byteLength(input.content) > MARKDOWN_LIMIT || input.content.includes("\0") || containsSecret(input.content))
      throw new AppError("VALIDATION", "La propuesta supera 64 KiB o contiene datos sensibles");
    const current = await read(await repo(p.id), row.path);
    const taskId = newId("tsk");
    const now = nowIso();
    tx(db, () => {
      if (input.version !== getFile(p.id, p.fileId).version || row.sha256 !== current.sha256)
        throw new AppError("VERSION_CONFLICT", "El archivo cambió. Registrá la versión actual antes de proponer cambios.");
      if (current.content === input.content) throw new AppError("VALIDATION", "Editá el Markdown antes de proponer un cambio");
      const actor = req.auth!.userId;
      run(db, "INSERT INTO task(id,project_id,title,description,type,priority,state,created_at,updated_at) VALUES(?,?,?,?,'docs','medium','READY',?,?)",
        taskId, p.id, `Actualizar ${row.path}`.slice(0, 200), "Propuesta de actualización de contexto Markdown.", now, now);
      run(db, "INSERT INTO acceptance_criterion(id,task_id,text,position) VALUES(?,?,?,0)", newId("ac"), taskId, `El diff contiene únicamente la propuesta para ${row.path}`);
      run(db, "INSERT INTO task_history(task_id,from_state,to_state,actor_id,reason,created_at) VALUES(?,NULL,'READY',?,?,?)", taskId, actor, "propuesta de contexto", now);
      run(db, "INSERT INTO context_proposal(task_id,file_id,path,base_sha256,content) VALUES(?,?,?,?,?)", taskId, row.id, row.path, markdownWorktreeSha(current.content), input.content);
      audit(db, { actorId: actor, action: "context.propose", entityType: "task", entityId: taskId, outcome: "OK", detail: { fileId: row.id, sha256: row.sha256 }, correlationId: req.id });
    });
    return ok({ taskId }, req.id);
  });
}
