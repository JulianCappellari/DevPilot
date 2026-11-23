import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fail, ok, type ErrorCode } from "@devpilot/contracts";
import type { AgentProvider } from "@devpilot/providers";
import { all, audit, get, newId, nowIso, parseOrigin, run, type Config, type DB } from "@devpilot/storage";
import { z } from "zod";
import { LoginLimiter, authenticate, createSession, safeEqual, verifyPassword, type AuthContext } from "./auth.js";
import { AppError, toHttpError } from "./errors.js";
import { registerDomainRoutes } from "./routes.js";
import type { GithubReader, PrPublisher } from "./github.js";

export type AppDeps = { db: DB; config: Config; providers: Map<string, AgentProvider>; logger?: boolean; prPublisher?: PrPublisher; githubReader?: GithubReader };

declare module "fastify" {
  interface FastifyRequest { auth: AuthContext | null }
}

const COOKIE = "dp_session";
const PUBLIC_PATHS = new Set(["/api/v1/auth/login", "/api/v1/health"]);
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/public");

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, config } = deps;
  const app = Fastify({ logger: deps.logger ? { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] } : false, genReqId: () => randomUUID(), bodyLimit: 1_000_000 });
  const limiter = new LoginLimiter();
  app.decorateRequest("auth", null);
  void app.register(fastifyCookie);

  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-correlation-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header("cache-control", req.url.startsWith("/api/") ? "no-store" : "no-cache"); // estáticos: siempre revalidar por ETag
    done();
  });

  const sendFail = (reply: FastifyReply, req: FastifyRequest, e: unknown) => {
    const h = toHttpError(e);
    if (h.code === "INTERNAL") req.log.error(e);
    if (e instanceof AppError && e.auditDenied) audit(db, { actorId: req.auth?.userId ?? null, action: `${req.method} ${req.routeOptions.url ?? req.url}`, entityType: "request", entityId: ((req.params as { id?: unknown } | undefined)?.id as string | undefined) ?? null, outcome: "DENIED", detail: { message: e.message }, correlationId: req.id });
    return reply.status(h.status).send(fail(h.code as ErrorCode, h.message, req.id));
  };
  app.setErrorHandler((e, req, reply) => {
    const h = toHttpError(e);
    if (h.code === "INTERNAL") {
      if ((e as { statusCode?: number }).statusCode === 400 || (e as { statusCode?: number }).statusCode === 413) return reply.status(400).send(fail("VALIDATION", "Solicitud inválida", req.id));
      req.log.error(e);
      return reply.status(500).send({ data: null, error: { code: "INTERNAL", message: "Error interno" }, meta: {}, correlationId: req.id });
    }
    return sendFail(reply, req, e);
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send(fail("NOT_FOUND", "Recurso no encontrado", req.id));
    return reply.status(404).send("Not found");
  });

  // Autenticación + CSRF para todo /api/v1 excepto rutas públicas (RNF-003).
  app.addHook("preHandler", (req, reply, done) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/v1/")) return done();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (mutating) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const normalized = parseOrigin(origin);
        const direct = parseOrigin(`${req.protocol}://${req.headers.host ?? ""}`);
        if (!normalized || (normalized !== direct && !config.allowedOrigins.includes(normalized)))
          return sendFail(reply, req, new AppError("FORBIDDEN", "Origen no permitido", true));
      }
    }
    if (PUBLIC_PATHS.has(url)) return done();
    req.auth = authenticate(db, req.cookies[COOKIE]);
    if (!req.auth) return sendFail(reply, req, new AppError("UNAUTHENTICATED", "Sesión inválida o expirada"));
    if (mutating) {
      const t = req.headers["x-csrf-token"];
      if (typeof t !== "string" || !safeEqual(t, req.auth.csrfToken)) return sendFail(reply, req, new AppError("FORBIDDEN", "Token CSRF inválido", true));
    }
    done();
  });

  const P = "/api/v1";
  app.get(`${P}/health`, async (req) => ok({ status: "ok", time: nowIso() }, req.id));

  app.post(`${P}/auth/login`, async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }).strict().parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    if (limiter.blocked(key)) {
      audit(db, { actorId: null, action: "auth.login", entityType: "user", outcome: "DENIED", detail: { reason: "rate_limited", username: body.username }, correlationId: req.id });
      throw new AppError("RATE_LIMITED", "Demasiados intentos; esperá unos minutos");
    }
    const u = get<{ id: string; password_hash: string }>(db, "SELECT id, password_hash FROM user WHERE username = ?", body.username);
    // Se verifica siempre un hash para igualar tiempos entre usuario inexistente y contraseña errónea.
    const good = verifyPassword(body.password, u?.password_hash ?? "scrypt$16384$00$00") && !!u;
    if (!good || !u) {
      limiter.fail(key);
      audit(db, { actorId: null, action: "auth.login", entityType: "user", outcome: "DENIED", detail: { username: body.username }, correlationId: req.id });
      throw new AppError("UNAUTHENTICATED", "Credenciales inválidas");
    }
    limiter.reset(key);
    const s = createSession(db, u.id, config.sessionTtlMs, req.ip, String(req.headers["user-agent"] ?? ""));
    reply.setCookie(COOKIE, s.token, { httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", maxAge: Math.floor(config.sessionTtlMs / 1000) });
    audit(db, { actorId: u.id, action: "auth.login", entityType: "session", entityId: s.sessionId, outcome: "OK", correlationId: req.id });
    return ok({ username: body.username, csrfToken: s.csrfToken, expiresAt: s.expiresAt }, req.id);
  });

  app.post(`${P}/auth/logout`, async (req, reply) => {
    run(db, "UPDATE session SET revoked_at = ? WHERE id = ?", nowIso(), req.auth!.sessionId);
    reply.clearCookie(COOKIE, { path: "/" });
    audit(db, { actorId: req.auth!.userId, action: "auth.logout", entityType: "session", entityId: req.auth!.sessionId, outcome: "OK", correlationId: req.id });
    return ok({ loggedOut: true }, req.id);
  });

  app.get(`${P}/auth/me`, async (req) => ok({ username: req.auth!.username, csrfToken: req.auth!.csrfToken, sessionId: req.auth!.sessionId }, req.id));

  app.get(`${P}/auth/sessions`, async (req) => {
    const rows = all(db, "SELECT id, created_at, expires_at, revoked_at, ip, user_agent FROM session WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", req.auth!.userId);
    return ok(rows.map((r) => ({ ...r, current: r["id"] === req.auth!.sessionId })), req.id);
  });

  app.post(`${P}/auth/revoke-others`, async (req) => {
    const r = run(db, "UPDATE session SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL", nowIso(), req.auth!.userId, req.auth!.sessionId);
    audit(db, { actorId: req.auth!.userId, action: "auth.revoke_others", entityType: "session", outcome: "OK", detail: { revoked: r.changes }, correlationId: req.id });
    return ok({ revoked: r.changes }, req.id);
  });

  registerDomainRoutes(app, deps, P);

  if (existsSync(WEB_ROOT)) void app.register(fastifyStatic, { root: WEB_ROOT, prefix: "/", wildcard: false, cacheControl: false, setHeaders: (res) => { res.header("cache-control", "no-cache"); } });
  void newId;
  return app;
}
