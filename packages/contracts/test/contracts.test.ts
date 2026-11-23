import { describe, expect, it } from "vitest";
import { CreateTaskInputSchema, HTTP_STATUS, ErrorCodeSchema, fail, formatSse, ok, parseEventCursor } from "../src/index.js";

describe("contratos API", () => {
  const valid = {
    projectId: "prj_123", title: "Corregir redireccion post-login", type: "bug", priority: "medium",
    acceptanceCriteria: ["Usuario autenticado navega a /dashboard", "Test de regresion de auth pasa"],
  };
  it("acepta el ejemplo de la spec §10.1", () => {
    expect(CreateTaskInputSchema.safeParse(valid).success).toBe(true);
  });
  it("rechaza campos desconocidos (mass assignment) y valores inválidos", () => {
    expect(CreateTaskInputSchema.safeParse({ ...valid, state: "APPROVED" }).success).toBe(false);
    expect(CreateTaskInputSchema.safeParse({ ...valid, type: "hack" }).success).toBe(false);
    expect(CreateTaskInputSchema.safeParse({ ...valid, title: "ab" }).success).toBe(false);
    expect(CreateTaskInputSchema.safeParse({ ...valid, acceptanceCriteria: [""] }).success).toBe(false);
  });
  it("criterios ausentes se normalizan a [] (la tarea quedará DRAFT)", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest["acceptanceCriteria"];
    const r = CreateTaskInputSchema.parse(rest);
    expect(r.acceptanceCriteria).toEqual([]);
  });
  it("todos los códigos de error tienen estado HTTP según §10.2", () => {
    for (const c of ErrorCodeSchema.options) expect(HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(HTTP_STATUS.VERSION_CONFLICT).toBe(409);
    expect(HTTP_STATUS.INVALID_STATE).toBe(422);
  });
  it("envelope { data, error, meta, correlationId }", () => {
    expect(ok({ a: 1 }, "c1")).toEqual({ data: { a: 1 }, error: null, meta: {}, correlationId: "c1" });
    expect(fail("FORBIDDEN", "no", "c2")).toMatchObject({ data: null, error: { code: "FORBIDDEN" }, correlationId: "c2" });
  });
  it("formatea SSE y parsea el cursor de reanudación", () => {
    expect(formatSse("run.progress", "run_123", 49, { s: 1 })).toBe('event: run.progress\nid: run_123:49\ndata: {"s":1}\n\n');
    expect(parseEventCursor("run_123:49")).toBe(49);
    expect(parseEventCursor(undefined)).toBe(0);
    expect(parseEventCursor("garbage")).toBe(0);
    expect(parseEventCursor("run:-1")).toBe(0);
  });
});
