import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  assertWorkspaceAllowed,
  consoleDisplayHost,
  ConsoleInputError,
  type ResolvedConsoleConfig,
} from "./config.js";
import type {
  AcpxConsoleSessionService,
  ConsoleBootstrap,
  ConsoleSession,
  ProviderSession,
  ServiceInvalidation,
} from "./contracts.js";
import {
  applySecurityHeaders,
  assertAllowedHost,
  assertMutationRequest,
  assertSameOriginRequest,
  HttpError,
  InFlightRequestLimiter,
  MutationRateLimiter,
  optionalString,
  readJsonBody,
  requiredString,
} from "./security.js";
import { writeSseFrameOrDisconnect } from "./sse.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_REPLAY_LIMIT = 512;
const MAX_SSE_CLIENTS = 64;
const MAX_SERVER_CONNECTIONS = 128;
const TIMELINE_PAGE_LIMIT = 100;
const MAX_TIMELINE_PAGE_LIMIT = 500;
const MAX_PROVIDER_ENUMERATIONS = 8;
const MAX_PROVIDER_ENUMERATIONS_PER_CLIENT = 2;

interface BufferedEvent {
  id: number;
  event: ServiceInvalidation | { type: "reset" };
}

export interface AcpxConsoleServerOptions {
  config: ResolvedConsoleConfig;
  service: AcpxConsoleSessionService;
  logger?: Pick<Console, "error" | "info" | "warn">;
  mutationRateLimit?: { maxRequests: number; windowMs: number };
  providerEnumerationLimit?: { global: number; perClient: number };
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
      code?: string;
      detailCode?: string;
      earliestCursor?: string;
    };
    const code = shaped.detailCode ?? shaped.code;
    const safeCode = shaped.name === "SessionNotFoundError" ? "SESSION_NOT_FOUND" : code;
    const mapping = safeCode ? SAFE_SERVICE_ERRORS[safeCode] : undefined;
    if (mapping) {
      const details =
        safeCode === "CURSOR_EXPIRED" && shaped.earliestCursor
          ? { earliestCursor: shaped.earliestCursor }
          : undefined;
      return {
        response: new HttpError(mapping.statusCode, safeCode!, mapping.message, details),
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

const SAFE_SERVICE_ERRORS: Readonly<
  Record<string, { statusCode: number; message: string } | undefined>
> = {
  SESSION_NOT_FOUND: { statusCode: 404, message: "Session not found" },
  CURSOR_INVALID: { statusCode: 400, message: "Timeline cursor is invalid" },
  CURSOR_EXPIRED: { statusCode: 410, message: "Timeline cursor has expired" },
  AGENT_NOT_REGISTERED: { statusCode: 400, message: "Agent is not registered" },
  SESSION_ADOPTION_FAILED: { statusCode: 422, message: "Provider session could not be adopted" },
  SESSION_START_RESULT_UNKNOWN: {
    statusCode: 409,
    message: "Session start result is unknown; reconcile before retrying",
  },
  AGENT_CAPABILITY_UNSUPPORTED: {
    statusCode: 422,
    message: "Agent does not support this operation",
  },
  IDEMPOTENCY_KEY_CONFLICT: { statusCode: 409, message: "Idempotency key conflicts" },
  IDEMPOTENCY_RESULT_UNKNOWN: { statusCode: 409, message: "Mutation result is unknown" },
  IDEMPOTENCY_RECORD_CORRUPT: { statusCode: 409, message: "Mutation record is unavailable" },
  IDEMPOTENT_MUTATION_FAILED: { statusCode: 409, message: "Mutation previously failed" },
  TURN_CONFLICT: { statusCode: 409, message: "Session cannot accept this turn" },
  TURN_NOT_ACTIVE: { statusCode: 409, message: "Turn is not active" },
  PENDING_REQUEST_NOT_ANSWERABLE: { statusCode: 409, message: "Request is not answerable" },
  PENDING_REQUEST_OWNER_GONE: { statusCode: 410, message: "Request owner is no longer live" },
  PENDING_REQUEST_ANSWER_TIMEOUT: { statusCode: 504, message: "Request answer timed out" },
  UNSUPPORTED_PROMPT_CONTENT: { statusCode: 400, message: "Prompt content is unsupported" },
};

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

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

async function openStaticFile(
  candidate: string,
  staticRoot: string,
): Promise<{ handle: FileHandle; canonicalPath: string } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    if (code === "ELOOP") {
      throw new HttpError(400, "INVALID_PATH", "Static asset path is invalid");
    }
    throw error;
  }
  try {
    const [opened, canonicalPath] = await Promise.all([handle.stat(), realpath(candidate)]);
    if (!opened.isFile()) {
      await handle.close();
      return undefined;
    }
    const canonical = await stat(canonicalPath);
    if (
      !isContainedPath(staticRoot, canonicalPath) ||
      opened.dev !== canonical.dev ||
      opened.ino !== canonical.ino
    ) {
      throw new HttpError(400, "INVALID_PATH", "Static asset path is invalid");
    }
    return { handle, canonicalPath };
  } catch (error) {
    await handle.close();
    throw error;
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
  const staticRoot = await realpath(staticDir).catch(() => undefined);
  if (!staticRoot) {
    throw new HttpError(503, "WEB_ASSETS_MISSING", "ACPX Console web assets are not installed");
  }
  const candidate = join(staticRoot, relative === "" ? "index.html" : relative);
  let asset = await openStaticFile(candidate, staticRoot);
  if (!asset) {
    asset = await openStaticFile(join(staticRoot, "index.html"), staticRoot);
  }
  if (!asset) {
    throw new HttpError(503, "WEB_ASSETS_MISSING", "ACPX Console web assets are not installed");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(asset.canonicalPath));
  if (asset.canonicalPath.endsWith("index.html")) {
    response.setHeader("Cache-Control", "no-store");
  } else {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (method === "HEAD") {
    await asset.handle.close();
    response.end();
  } else {
    try {
      await pipeline(asset.handle.createReadStream({ autoClose: false }), response);
    } finally {
      await asset.handle.close();
    }
  }
}

function assertPendingResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_INPUT", "response must be a tagged answer object");
  }
  const answer = value as Record<string, unknown>;
  if (answer.type === "select" && typeof answer.option_id === "string" && answer.option_id !== "") {
    return;
  }
  if (answer.type === "decline" || answer.type === "cancel") {
    return;
  }
  if (
    answer.type === "accept" &&
    answer.content &&
    typeof answer.content === "object" &&
    !Array.isArray(answer.content) &&
    Object.values(answer.content as Record<string, unknown>).every((field) => {
      const scalar =
        typeof field === "string" || typeof field === "number" || typeof field === "boolean";
      return scalar || (Array.isArray(field) && field.every((item) => typeof item === "string"));
    })
  ) {
    return;
  }
  throw new HttpError(400, "INVALID_INPUT", "response has an unsupported answer shape");
}

function routeMatch(pathname: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch (error) {
    if (error instanceof URIError) {
      throw new HttpError(400, "INVALID_PATH", "API path is invalid");
    }
    throw error;
  }
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

async function canonicalAllowedWorkspace(
  cwd: string | undefined,
  roots: string[],
): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }
  try {
    return await assertWorkspaceAllowed(cwd, roots);
  } catch {
    return undefined;
  }
}

async function allowedSessions(
  service: AcpxConsoleSessionService,
  roots: string[],
): Promise<ConsoleSession[]> {
  const sessions = await service.listSessions();
  const decisions = await Promise.all(
    sessions.map(
      async (session) => (await canonicalAllowedWorkspace(session.cwd, roots)) !== undefined,
    ),
  );
  return sessions.filter((_, index) => decisions[index]);
}

async function requireAllowedSession(
  service: AcpxConsoleSessionService,
  roots: string[],
  acpxRecordId: string,
): Promise<ConsoleSession> {
  const session = await service.getSession({ acpxRecordId });
  if (!session || !(await canonicalAllowedWorkspace(session.cwd, roots))) {
    throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
  }
  return session;
}

async function scopedProviderSessions(
  sessions: ProviderSession[],
  cwd: string,
  roots: string[],
): Promise<ProviderSession[]> {
  const canonical = await Promise.all(
    sessions.map(async (session) => await canonicalAllowedWorkspace(session.cwd, roots)),
  );
  return sessions.filter((_, index) => canonical[index] === cwd);
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    config: ResolvedConsoleConfig;
    service: AcpxConsoleSessionService;
    csrfToken: string;
    mutationRateLimiter: MutationRateLimiter;
    providerEnumerationLimiter: InFlightRequestLimiter;
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
  if (method === "GET" && path.startsWith("/api/")) {
    assertSameOriginRequest(request);
  }
  if (method === "GET" && path === "/api/v1/bootstrap") {
    response.setHeader(
      "Set-Cookie",
      `acpx_console_csrf=${encodeURIComponent(context.csrfToken)}; Path=/; HttpOnly; SameSite=Strict`,
    );
    const [agents, sessions] = await Promise.all([
      context.service.listAgents({ cwd: context.config.workspaceRoots[0] }),
      allowedSessions(context.service, context.config.workspaceRoots),
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
    sendJson(response, 200, {
      sessions: await allowedSessions(context.service, context.config.workspaceRoots),
    });
    return true;
  }
  if (method === "GET" && path === "/api/v1/agents") {
    const cwdParam = url.searchParams.get("cwd");
    if (!cwdParam) {
      throw new ConsoleInputError("Agent inventory requires an explicit cwd");
    }
    const cwd = await assertWorkspaceAllowed(cwdParam, context.config.workspaceRoots);
    sendJson(response, 200, { agents: await context.service.listAgents({ cwd }) });
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
    if ((await canonicalAllowedWorkspace(session.cwd, context.config.workspaceRoots)) !== cwd) {
      throw new HttpError(500, "INTERNAL_ERROR", "ACPX Console could not complete the request");
    }
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
      mode: optionalString(body, "mode"),
      idempotencyKey: idempotencyKey!,
    });
    if ((await canonicalAllowedWorkspace(session.cwd, context.config.workspaceRoots)) !== cwd) {
      throw new HttpError(500, "INTERNAL_ERROR", "ACPX Console could not complete the request");
    }
    sendJson(response, 201, { session });
    return true;
  }

  const provider = routeMatch(path, /^\/api\/v1\/agents\/([^/]+)\/sessions$/);
  if (method === "GET" && provider) {
    const cwdParam = url.searchParams.get("cwd");
    if (!cwdParam) {
      throw new ConsoleInputError("Provider session inventory requires an explicit cwd");
    }
    const cwd = await assertWorkspaceAllowed(cwdParam, context.config.workspaceRoots);
    const client = request.socket.remoteAddress ?? "unknown";
    const page = await context.providerEnumerationLimiter.run(
      client,
      async () =>
        await context.service.listProviderSessions({
          agentId: provider[0],
          cwd,
          cursor: url.searchParams.get("cursor") ?? undefined,
        }),
    );
    sendJson(response, 200, {
      ...page,
      sessions: await scopedProviderSessions(page.sessions, cwd, context.config.workspaceRoots),
    });
    return true;
  }

  const timeline = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)\/timeline$/);
  if (method === "GET" && timeline) {
    await requireAllowedSession(context.service, context.config.workspaceRoots, timeline[0]);
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
    await requireAllowedSession(context.service, context.config.workspaceRoots, pending[0]);
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
    await requireAllowedSession(context.service, context.config.workspaceRoots, responseRoute[0]);
    const body = await readJsonBody(request);
    if (!("response" in body)) {
      throw new HttpError(400, "INVALID_INPUT", "response is required");
    }
    assertPendingResponse(body.response);
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
    await requireAllowedSession(context.service, context.config.workspaceRoots, turns[0]);
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
    await requireAllowedSession(context.service, context.config.workspaceRoots, cancel[0]);
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
    await requireAllowedSession(context.service, context.config.workspaceRoots, close[0]);
    sendJson(response, 200, {
      close: await context.service.closeSession({
        acpxRecordId: close[0],
        idempotencyKey: idempotencyKey!,
      }),
    });
    return true;
  }
  const session = routeMatch(path, /^\/api\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && session) {
    const value = await requireAllowedSession(
      context.service,
      context.config.workspaceRoots,
      session[0],
    );
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
  const selectedDisplayHost = consoleDisplayHost(options.config);
  const csrfToken = randomBytes(32).toString("base64url");
  const mutationRateLimiter = new MutationRateLimiter(
    options.mutationRateLimit?.maxRequests,
    options.mutationRateLimit?.windowMs,
  );
  const providerEnumerationLimiter = new InFlightRequestLimiter(
    options.providerEnumerationLimit?.global ?? MAX_PROVIDER_ENUMERATIONS,
    options.providerEnumerationLimit?.perClient ?? MAX_PROVIDER_ENUMERATIONS_PER_CLIENT,
  );
  const events: BufferedEvent[] = [];
  const clients = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let nextEventId = 1;
  let publishQueue = Promise.resolve();

  const disconnectSlowClient = (client: ServerResponse): void => {
    clients.delete(client);
    client.destroy();
  };

  const sendSse = (client: ServerResponse, item: BufferedEvent): boolean => {
    if (writeSseFrameOrDisconnect(client, item)) {
      return true;
    }
    clients.delete(client);
    return false;
  };

  const publish = (event: ServiceInvalidation): void => {
    publishQueue = publishQueue
      .then(async () => {
        if (event.acpxRecordId) {
          try {
            await requireAllowedSession(
              options.service,
              options.config.workspaceRoots,
              event.acpxRecordId,
            );
          } catch (error) {
            if (error instanceof HttpError && error.code === "SESSION_NOT_FOUND") {
              return;
            }
            throw error;
          }
        }
        publishAllowed(event);
      })
      .catch((error: unknown) => logger.error(error));
  };

  const publishAllowed = (event: ServiceInvalidation): void => {
    const item = { id: nextEventId++, event };
    events.push(item);
    if (events.length > SSE_REPLAY_LIMIT) {
      events.shift();
    }
    for (const client of clients) {
      sendSse(client, item);
    }
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = options.service.subscribe?.(publish);
  } catch (error) {
    await options.service.dispose?.();
    throw error;
  }
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
        providerEnumerationLimiter,
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.config.port, options.config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    unsubscribe?.();
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await options.service.dispose?.();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.config.port;
  const displayHost = selectedDisplayHost.includes(":")
    ? `[${selectedDisplayHost}]`
    : selectedDisplayHost;
  const origin = `http://${displayHost}:${port}`;
  logger.info(`ACPX Console listening at ${origin}`);
  if (options.config.trustNetwork && !options.config.host.startsWith("127.")) {
    logger.warn(
      "Network trust enabled: every browser that can reach this address has session-control authority.",
    );
  }
  let closeStarted: Promise<void> | undefined;
  return {
    server,
    origin,
    csrfToken,
    close() {
      closeStarted ??= (async () => {
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
      })();
      return closeStarted;
    },
  };
}
