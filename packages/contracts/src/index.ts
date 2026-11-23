import { z } from "zod";

/** Contratos de API v1 (spec §10). Validación en el borde del sistema. */
export const TaskTypeSchema = z.enum(["bug", "feature", "refactor", "docs", "test", "chore"]);
export const PrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export const TaskLabelsSchema = z.array(z.string().trim().min(1).max(30).regex(/^[\p{L}\p{N} _-]+$/u))
  .max(10).transform((labels) => [...new Set(labels.map((label) => label.toLowerCase()))]);

export const CreateTaskInputSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    title: z.string().trim().min(3).max(200),
    description: z.string().max(10_000).optional(),
    type: TaskTypeSchema,
    priority: PrioritySchema,
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    labels: TaskLabelsSchema.default([]),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const ErrorCodeSchema = z.enum([
  "VALIDATION", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND",
  "VERSION_CONFLICT", "INVALID_STATE", "RATE_LIMITED", "PROVIDER_UNAVAILABLE",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Código HTTP por error (spec §10.2). */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  VERSION_CONFLICT: 409, INVALID_STATE: 422, RATE_LIMITED: 429, PROVIDER_UNAVAILABLE: 503,
};

export const ApiErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string() });
export type ApiEnvelope<T> = {
  data: T | null;
  error: z.infer<typeof ApiErrorSchema> | null;
  meta: Record<string, unknown>;
  correlationId: string;
};

export const ok = <T>(data: T, correlationId: string, meta: Record<string, unknown> = {}): ApiEnvelope<T> =>
  ({ data, error: null, meta, correlationId });
export const fail = (code: ErrorCode, message: string, correlationId: string): ApiEnvelope<never> =>
  ({ data: null, error: { code, message }, meta: {}, correlationId });

/** Eventos SSE con cursor `runId:seq` (spec §10.3). */
export const RunEventTypeSchema = z.enum([
  "run.progress", "run.log", "run.file_changed", "run.check.finished", "run.state", "run.completed", "run.error",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const formatSse = (type: RunEventType, runId: string, seq: number, data: unknown): string =>
  `event: ${type}\nid: ${runId}:${seq}\ndata: ${JSON.stringify(data)}\n\n`;

export const parseEventCursor = (id: string | undefined): number => {
  if (!id) return 0;
  const m = /^[A-Za-z0-9_-]+:(\d{1,9})$/.exec(id);
  return m ? Number(m[1]) : 0;
};
