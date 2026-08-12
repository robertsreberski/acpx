import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { assertWorkspaceAllowed, ConsoleInputError, type ResolvedConsoleConfig } from "./config.js";
import type {
  AcpxConsoleSessionService,
  ConsoleBootstrap,
  ServiceInvalidation,
} from "./contracts.js";
import {
  applySecurityHeaders,
  assertAllowedHost,
  assertMutationRequest,
  HttpError,
  MutationRateLimiter,
  optionalString,
  readJsonBody,
  requiredString,
} from "./security.js";
import { writeSseFrame } from "./sse.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_REPLAY_LIMIT = 512;
const MAX_SSE_CLIENTS = 64;
const MAX_SERVER_CONNECTIONS = 128;
const TIMELINE_PAGE_LIMIT = 100;
const MAX_TIMELINE_PAGE_LIMIT = 500;

interface BufferedEvent {
  id: number;
  event: ServiceInvalidation | { type: "reset" };
}

export interface AcpxConsoleServerOptions {
  config: ResolvedConsoleConfig;
  service: AcpxConsoleSessionService;
  logger?: Pick<Console, "error" | "info" | "warn">;
  mutationRateLimit?: { maxRequests: number; windowMs: number };
}

export interface RunningAcpxConsoleServer {
  server: Server;
  origin: string;
  csrfToken: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", JSON_CONTENT_TYPE);
  response.end(JSON.stringify(body));
}

function serviceError(error: unknown): { response: HttpError; original?: unknown } {
  if (error instanceof HttpError) {
    return { response: error };
  }
  if (error instanceof ConsoleInputError) {
    return { response: new HttpError(error.statusCode, error.code, error.message) };
  }
  if (error instanceof Error) {
    const shaped = error as Error & {
      statusCode?: number;
      code?: string;
      detailCode?: string;
      details?: unknown;
      outputCode?: string;
    };
    if (
      typeof shaped.statusCode === "number" &&
      shaped.statusCode >= 400 &&
      shaped.statusCode < 500
    ) {
      return {
        response: new HttpError(
          shaped.statusCode,
          shaped.detailCode ?? shaped.code ?? "REQUEST_FAILED",
          shaped.message,
          shaped.details,
        ),
      };
    }
    const code = shaped.detailCode ?? shaped.code;
    const mappedStatus =
      shaped.name === "SessionNotFoundError"
        ? 404
        : code === "IDEMPOTENCY_KEY_CONFLICT" || code === "TURN_CONFLICT"
          ? 409
          : code === "TURN_NOT_ACTIVE" || code === "PENDING_REQUEST_NOT_ANSWERABLE"
            ? 409
            : code === "PENDING_REQUEST_OWNER_GONE"
              ? 410
              : code === "AGENT_CAPABILITY_UNSUPPORTED"
                ? 422
                : shaped.outputCode === "USAGE"
                  ? 400
                  : undefined;
    if (mappedStatus !== undefined) {
      return {
        response: new HttpError(mappedStatus, code ?? "REQUEST_FAILED", shaped.message),
      };
    }
    return {
      response: new HttpError(500, "INTERNAL_ERROR", "ACPX Console could not complete the request"),
      original: error,
    };
  }
  return {
    response: new HttpError(500, "INTERNAL_ERROR", "ACPX Console could not complete the request"),
    original: error,
  };
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return JSON_CONTENT_TYPE;
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function serveStatic(
  requestPath: string,
  method: string,
  response: ServerResponse,
  staticDir: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch (error) {
    if (error instanceof URIError) {
      throw new HttpError(400, "INVALID_PATH", "Static asset path is invalid");
    }
    throw error;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  if (relative === ".." || relative.startsWith(`..${sep}`)) {
    throw new HttpError(400, "INVALID_PATH", "Static asset path is invalid");
  }
  const candidate = join(staticDir, relative === "" ? "index.html" : relative);
  const path = (await fileExists(candidate)) ? candidate : join(staticDir, "index.html");
  if (!(await fileExists(path))) {
    throw new HttpError(503, "WEB_ASSETS_MISSING", "ACPX Console web assets are not installed");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(path));
  if (path.endsWith("index.html")) {
    response.setHeader("Cache-Control", "no-store");
  } else {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (method === "HEAD") {
    response.end();
  } else {
    createReadStream(path).pipe(response);
  }
}

function routeMatch(pathname: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(pathname);
  return match?.slice(1).map((value) => decodeURIComponent(value));
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) {
    return TIMELINE_PAGE_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMELINE_PAGE_LIMIT) {
    throw new HttpError(
      400,
      "INVALID_LIMIT",
      `limit must be between 1 and ${MAX_TIMELINE_PAGE_LIMIT}`,
    );
  }
  return value;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    config: ResolvedConsoleConfig;
    service: AcpxConsoleSessionService;
    csrfToken: string;
    mutationRateLimiter: MutationRateLimiter;
    connectSse(response: ServerResponse, lastEventId?: string): void;
  },
): Promise<boolean> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const mutate = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const idempotencyKey = mutate ? assertMutationRequest(request, context.csrfToken) : undefined;
  if (mutate) {
    context.mutationRateLimiter.check(request.socket.remoteAddress ?? "unknown");
  }

  if (method === "GET" && path === "/healthz") {
    sendJson(response, 200, { status: "ok", version: 1 });
    return true;
  }
  if (method === "GET" && path === "/api/v1/bootstrap") {
    response.setHeader(
      "Set-Cookie",
      `acpx_console_csrf=${encodeURIComponent(context.csrfToken)}; Path=/; HttpOnly; SameSite=Strict`,
    );
    const [agents, sessions] = await Promise.all([
      context.service.listAgents(),
      context.service.listSessions(),
    ]);
    const body: ConsoleBootstrap = {
      version: 1,
      csrfToken: context.csrfToken,
      agents,
      sessions,
      workspaceRoots: context.config.workspaceRoots,
      server: {
        host: context.config.host,
        port: context.config.port,
        networkTrusted: context.config.trustNetwork,
      },
    };
    sendJson(response, 200, body);
    return true;
  }
  if (method === "GET" && path === "/api/v1/events") {
    const lastEventId = request.headers["last-event-id"];
    context.connectSse(response, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
    return true;
  }
  if (method === "GET" && path === "/api/v1/sessions") {
    sendJson(response, 200, { sessions: await context.service.listSessions() });
    return true;
  }
  if (method === "POST" && path === "/api/v1/sessions") {
    const body = await readJsonBody(request);
    if (body.policy !== undefined && body.policy !== "defer-risky") {
      throw new HttpError(
        400,
        "INVALID_PERMISSION_POLICY",
        "ACPX Console only accepts the defer-risky permission policy",
      );
    }
    const cwd = await assertWorkspaceAllowed(
      requiredString(body, "cwd"),
      context.config.workspaceRoots,
    );
    const session = await context.service.createSession({
      agentId: requiredString(body, "agentId"),
      cwd,
      name: optionalString(body, "name"),
      mode: optionalString(body, "mode"),
      model: optionalString(body, "model"),
      policy: body.policy,
      idempotencyKey: idempotencyKey!,
    });
    sendJson(response, 201, { session });
    return true;
  }
  if (method === "POST" && path === "/api/v1/sessions/adopt") {
    const body = await readJsonBody(request);
    const cwd = await assertWorkspaceAllowed(
      requiredString(body, "cwd"),
      context.config.workspaceRoots,
    );
    const session = await context.service.adoptSession({
      agentId: requiredString(body, "agentId"),
      providerSessionId: requiredString(body, "providerSessionId"),
      cwd,
      name: optionalString(body, "name"),
      idempotencyKey: idempotencyKey!,
    });
    sendJson(response, 201, { session });
    return true;
  }

  const provider = routeMatch(path, /^\/api\/v1\/agents\/([^/]+)\/sessions$/);
  if (method === "GET" && provider) {
    const cwdParam = url.searchParams.get("cwd") ?? undefined;
    const cwd = cwdParam
      ? await assertWorkspaceAllowed(cwdParam, context.config.workspaceRoots)
      : undefined;
    sendJson(
      response,
      200,
      await context.service.listProviderSessions({
        agentId: provider[0],
        cwd,
        cursor: url.searchParams.get("cursor") ?? undefined,
      }),
    );
    return true;
  }

  const timeline = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/timeline$/);
  if (method === "GET" && timeline) {
    sendJson(
      response,
      200,
      await context.service.getTranscriptPage({
        acpxRecordId: timeline[0],
        before: url.searchParams.get("before") ?? undefined,
        limit: parseLimit(url),
      }),
    );
    return true;
  }
  const pending = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/pending$/);
  if (method === "GET" && pending) {
    sendJson(response, 200, {
      pending: await context.service.listPendingRequests({ acpxRecordId: pending[0] }),
    });
    return true;
  }
  const responseRoute = routeMatch(
    path,
    /^\/api\/v1\/sessions\/([^/]+)\/pending\/([^/]+)\/responses$/,
  );
  if (method === "POST" && responseRoute) {
    const body = await readJsonBody(request);
    if (!("response" in body)) {
      throw new HttpError(400, "INVALID_INPUT", "response is required");
    }
    const pendingResult = await context.service.respondToPendingRequest({
      acpxRecordId: responseRoute[0],
      requestId: responseRoute[1],
      response: body.response,
      idempotencyKey: idempotencyKey!,
    });
    sendJson(response, 200, { pending: pendingResult });
    return true;
  }
  const turns = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/turns$/);
  if (method === "POST" && turns) {
    const body = await readJsonBody(request);
    sendJson(
      response,
      202,
      await context.service.enqueuePrompt({
        acpxRecordId: turns[0],
        text: requiredString(body, "text"),
        idempotencyKey: idempotencyKey!,
      }),
    );
    return true;
  }
  const cancel = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/);
  if (method === "POST" && cancel) {
    sendJson(
      response,
      202,
      await context.service.cancelTurn({
        acpxRecordId: cancel[0],
        turnId: cancel[1],
        idempotencyKey: idempotencyKey!,
      }),
    );
    return true;
  }
  const close = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/close$/);
  if (method === "POST" && close) {
    sendJson(response, 200, {
      session: await context.service.closeSession({
        acpxRecordId: close[0],
        idempotencyKey: idempotencyKey!,
      }),
    });
    return true;
  }
  const session = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && session) {
    const value = await context.service.getSession({ acpxRecordId: session[0] });
    if (!value) {
      throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
    }
    sendJson(response, 200, { session: value });
    return true;
  }
  if (path.startsWith("/api/") || path === "/healthz") {
    throw new HttpError(404, "NOT_FOUND", "API route not found");
  }
  return false;
}

export async function startAcpxConsoleServer(
  options: AcpxConsoleServerOptions,
): Promise<RunningAcpxConsoleServer> {
  const logger = options.logger ?? console;
  const csrfToken = randomBytes(32).toString("base64url");
  const mutationRateLimiter = new MutationRateLimiter(
    options.mutationRateLimit?.maxRequests,
    options.mutationRateLimit?.windowMs,
  );
  const events: BufferedEvent[] = [];
  const clients = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let nextEventId = 1;

  const disconnectSlowClient = (client: ServerResponse): void => {
    clients.delete(client);
    client.destroy();
  };

  const sendSse = (client: ServerResponse, item: BufferedEvent): boolean => {
    if (writeSseFrame(client, item)) {
      return true;
    }
    disconnectSlowClient(client);
    return false;
  };

  const publish = (event: ServiceInvalidation): void => {
    const item = { id: nextEventId++, event };
    events.push(item);
    if (events.length > SSE_REPLAY_LIMIT) {
      events.shift();
    }
    for (const client of clients) {
      sendSse(client, item);
    }
  };
  const unsubscribe = options.service.subscribe?.(publish);
  const connectSse = (response: ServerResponse, lastEventId?: string): void => {
    if (clients.size >= MAX_SSE_CLIENTS) {
      sendJson(response, 503, {
        error: { code: "SSE_CAPACITY", message: "Too many live event-stream clients" },
      });
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("Cache-Control", "no-store");
    response.flushHeaders();
    const parsed = lastEventId === undefined ? undefined : Number(lastEventId);
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 0)) {
      if (!sendSse(response, { id: nextEventId++, event: { type: "reset" } })) {
        return;
      }
    } else if (parsed !== undefined && events.length > 0 && parsed < events[0].id - 1) {
      if (!sendSse(response, { id: nextEventId++, event: { type: "reset" } })) {
        return;
      }
    } else if (parsed !== undefined) {
      for (const event of events) {
        if (event.id > parsed && !sendSse(response, event)) {
          return;
        }
      }
    }
    if (!response.write(": connected\n\n")) {
      disconnectSlowClient(response);
      return;
    }
    clients.add(response);
    response.on("close", () => clients.delete(response));
  };

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      assertAllowedHost(request, options.config.allowedHosts);
      const handled = await handleApi(request, response, {
        config: options.config,
        service: options.service,
        csrfToken,
        mutationRateLimiter,
        connectSse,
      });
      if (!handled) {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(
            405,
            "METHOD_NOT_ALLOWED",
            "Only GET and HEAD are allowed for web assets",
          );
        }
        await serveStatic(
          url.pathname,
          request.method ?? "GET",
          response,
          options.config.staticDir,
        );
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const failure = serviceError(error);
      const httpError = failure.response;
      if (failure.original !== undefined) {
        logger.error(failure.original);
      }
      sendJson(response, httpError.statusCode, {
        error: { code: httpError.code, message: httpError.message, details: httpError.details },
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = MAX_SERVER_CONNECTIONS;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.port, options.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.config.port;
  const displayHost = options.config.host.includes(":")
    ? `[${options.config.host}]`
    : options.config.host;
  const origin = `http://${displayHost}:${port}`;
  logger.info(`ACPX Console listening at ${origin}`);
  if (options.config.trustNetwork && !options.config.host.startsWith("127.")) {
    logger.warn(
      "Network trust enabled: every browser that can reach this address has session-control authority.",
    );
  }
  return {
    server,
    origin,
    csrfToken,
    async close() {
      unsubscribe?.();
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      const closed = new Promise<void>((resolve, reject) => {
        server.once("close", resolve);
        server.once("error", reject);
      });
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closed;
      await options.service.dispose?.();
    },
  };
}
