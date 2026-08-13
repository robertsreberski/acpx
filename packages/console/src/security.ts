import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
}

export function requestHostname(request: IncomingMessage): string {
  const raw = request.headers.host;
  if (!raw) {
    throw new HttpError(400, "HOST_REQUIRED", "Host header is required");
  }
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new HttpError(400, "INVALID_HOST", "Host header is invalid");
  }
}

export function assertAllowedHost(request: IncomingMessage, allowedHosts: string[]): void {
  const hostname = requestHostname(request);
  if (!allowedHosts.includes(hostname)) {
    throw new HttpError(403, "HOST_NOT_ALLOWED", `Host is not allowed: ${hostname}`);
  }
}

export function assertSameOriginRequest(request: IncomingMessage): void {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "CROSS_SITE_REQUEST", "Cross-site requests are not allowed");
  }
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "INVALID_ORIGIN", "Origin is invalid");
  }
  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    parsedOrigin.host.toLowerCase() !== request.headers.host?.toLowerCase()
  ) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Cross-origin requests are not allowed");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function assertMutationRequest(request: IncomingMessage, csrfToken: string): string {
  assertSameOriginRequest(request);
  const headerToken = request.headers["x-csrf-token"];
  const cookieToken = cookieValue(request, "acpx_console_csrf");
  if (
    typeof headerToken !== "string" ||
    cookieToken === undefined ||
    !constantTimeEqual(headerToken, csrfToken) ||
    !constantTimeEqual(cookieToken, csrfToken)
  ) {
    throw new HttpError(403, "CSRF_FAILED", "A matching ACPX Console CSRF token is required");
  }
  const idempotencyKey = request.headers["idempotency-key"];
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 200
  ) {
    throw new HttpError(
      428,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Mutations require an Idempotency-Key header between 8 and 200 characters",
    );
  }
  return idempotencyKey;
}

export class InFlightRequestLimiter {
  private globalCount = 0;
  private readonly clientCounts = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perClientLimit: number,
  ) {
    if (globalLimit < 1 || perClientLimit < 1 || perClientLimit > globalLimit) {
      throw new Error("Invalid in-flight request limits");
    }
  }

  async run<T>(client: string, operation: () => Promise<T>): Promise<T> {
    const clientCount = this.clientCounts.get(client) ?? 0;
    if (clientCount >= this.perClientLimit) {
      throw new HttpError(
        429,
        "PROVIDER_ENUMERATION_LIMIT",
        "Too many provider-session requests from this client",
      );
    }
    if (this.globalCount >= this.globalLimit) {
      throw new HttpError(
        503,
        "PROVIDER_ENUMERATION_CAPACITY",
        "Provider-session request capacity is temporarily full",
      );
    }
    this.globalCount += 1;
    this.clientCounts.set(client, clientCount + 1);
    try {
      return await operation();
    } finally {
      this.globalCount -= 1;
      const remaining = (this.clientCounts.get(client) ?? 1) - 1;
      if (remaining === 0) {
        this.clientCounts.delete(client);
      } else {
        this.clientCounts.set(client, remaining);
      }
    }
  }

  get activeCount(): number {
    return this.globalCount;
  }
}

export class MutationRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly maxRequests = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxClients = 1_024,
  ) {}

  check(client: string): void {
    const now = this.now();
    const threshold = now - this.windowMs;
    for (const [key, bucket] of this.requests) {
      const active = bucket.filter((time) => time > threshold);
      if (active.length === 0) {
        this.requests.delete(key);
      } else if (active.length !== bucket.length) {
        this.requests.set(key, active);
      }
    }
    if (!this.requests.has(client) && this.requests.size >= this.maxClients) {
      throw new HttpError(
        503,
        "RATE_LIMIT_CAPACITY",
        "Mutation rate-limit capacity is temporarily full",
      );
    }
    const recent = (this.requests.get(client) ?? []).filter((time) => time > threshold);
    if (recent.length >= this.maxRequests) {
      this.requests.set(client, recent);
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "Too many mutation requests; retry after the current window",
      );
    }
    recent.push(now);
    this.requests.set(client, recent);
  }

  get clientCount(): number {
    return this.requests.size;
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "JSON_REQUIRED", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new HttpError(
        413,
        "BODY_TOO_LARGE",
        `JSON bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`,
      );
    }
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("body must be an object");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      error instanceof Error ? error.message : "Invalid JSON",
    );
  }
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_INPUT", `${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_INPUT", `${key} must be a non-empty string when provided`);
  }
  return value;
}
