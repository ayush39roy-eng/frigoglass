/**
 * Minimal typed fetch wrapper for the FastAPI backend (P3).
 *
 * There is no generated OpenAPI client yet (see `src/lib/api/README.md` and the
 * P4-T01 `docs/MEMORY.md` carry-forward note): this hand-written helper is the
 * interim transport every surface hook goes through until `openapi-typescript` /
 * `orval` output lands and replaces it.
 *
 * Design notes:
 * - No business logic. Callers get exactly the JSON the API returned.
 * - Auth: OIDC is handled server-side (P3-T02 / P6-T03). The browser SSO redirect
 *   flow is not built yet; `credentials: 'include'` is set so a cookie-based
 *   session works the moment P6-T03 wires it, and a `bearerToken` hook point is
 *   left for a future token-based flow. Neither path stores a secret in the repo.
 * - Errors: every non-2xx response becomes an `ApiError` carrying the HTTP status
 *   so hooks can special-case 401/403 (RBAC) without string-matching messages.
 */

import { getDevUserEmail } from './dev-user';

const RAW_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  /**
   * The optional machine-readable `code` of the P3 error envelope
   * (`{"detail": …, "code"?: str}`, P9 contract §9) — e.g. `LAST_SUPER_ADMIN`
   * (409), `CYCLE` / `BAD_PREDECESSOR` (422), `CATEGORY_WORKFLOW_MISMATCH`
   * (422). Surfaces branch on this, never on the human-readable `detail`.
   */
  readonly code: string | undefined;
  /** Whole seconds from a `Retry-After` header (429 `RATE_LIMITED`, P9-R02),
   *  when the server sent one as a number. Undefined otherwise. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, message: string, detail?: string, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export interface ApiRequestOptions {
  /** Query params — `undefined`/`null` values are dropped, others `String()`-ified. */
  query?: Record<string, string | number | boolean | null | undefined> | undefined;
  signal?: AbortSignal | null | undefined;
  /** Optional bearer token for a future token-based auth flow. */
  bearerToken?: string | undefined;
}

function buildUrl(path: string, query: ApiRequestOptions['query']): string {
  const url = new URL(
    `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`,
    // base for the relative case (BASE_URL === '')
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseError(response: Response): Promise<ApiError> {
  let detail: string | undefined;
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      if ('detail' in body) {
        const raw = (body as { detail: unknown }).detail;
        detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
      if ('code' in body) {
        const rawCode = (body as { code: unknown }).code;
        if (typeof rawCode === 'string') code = rawCode;
      }
    }
  } catch {
    // non-JSON error body — leave detail undefined
  }
  // Only the delta-seconds form of Retry-After is used by our API; an HTTP-date
  // (or garbage) is ignored rather than guessed at.
  const retryRaw = response.headers.get('Retry-After')?.trim();
  const retryAfterSeconds = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
  return new ApiError(
    response.status,
    `Request failed (${String(response.status)} ${response.statusText})`,
    detail,
    code,
    retryAfterSeconds,
  );
}

/**
 * Dev-mode identity header (ADR 0010 §4). Attached to every request ONLY when a
 * dev user has been selected via the header switcher (`lib/api/dev-user.ts`).
 * Outside dev mode the backend ignores the header and the switcher never
 * renders, so this is inert in production; it is still never sent unless set.
 */
export function devUserHeader(): Record<string, string> {
  const email = getDevUserEmail();
  return email ? { 'X-Dev-User-Email': email } : {};
}

export async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...devUserHeader() };
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: options.signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Network request failed — the API is unreachable.');
  }

  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Absolute URL for an API path — exported for the streaming SSE reader. */
export function apiUrl(path: string, query?: ApiRequestOptions['query']): string {
  return buildUrl(path, query);
}

/** Re-exported for sibling transports (`sse.ts`) so they share one error parser. */
export { parseError as parseApiError };

/**
 * Multipart upload (`POST /projects/{id}/files`, P9 contract §7). The browser
 * sets the multipart boundary, so no `Content-Type` is set here. Same error
 * contract as `apiSend`. The `FormData` is passed through untouched.
 */
export async function apiUpload<T>(path: string, form: FormData, options: ApiRequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: 'POST',
      headers: { Accept: 'application/json', ...devUserHeader() },
      credentials: 'include',
      signal: options.signal ?? null,
      body: form,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Network request failed — the API is unreachable.');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Parses a `Content-Disposition: attachment; filename="foo.csv"` header. */
function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1];
}

/**
 * Fetches a file response (CSV/XLSX export streamed by `GET /exports/*`,
 * P5-T08) as a `Blob`, preserving the server's `Content-Disposition` filename
 * when present. Same error contract as `apiGet`/`apiSend`: every non-2xx
 * becomes an `ApiError` carrying the HTTP status, so a caller can
 * special-case 403 exactly like every other read on this surface — an export
 * is a read (`docs/DOMAIN_RULES.md`), never a separately-derived permission.
 * No business logic: the bytes returned are exactly what the API sent.
 */
export async function apiDownload(
  path: string,
  options: ApiRequestOptions & { fallbackFilename: string },
): Promise<DownloadedFile> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: 'GET',
      headers: { Accept: '*/*', ...devUserHeader() },
      credentials: 'include',
      signal: options.signal ?? null,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Network request failed — the API is unreachable.');
  }

  if (!response.ok) throw await parseError(response);

  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get('Content-Disposition')) ??
    options.fallbackFilename;
  return { blob, filename };
}

/**
 * JSON-body write helper (POST / PUT / PATCH / DELETE). Same contract as
 * `apiGet`: no business logic, caller gets exactly the JSON the API returned,
 * every non-2xx becomes an `ApiError` carrying the HTTP status so a hook can
 * special-case 403 (RBAC — e.g. a read-only role attempting a Matrix score
 * edit) without string-matching messages. The request `body` is serialised
 * verbatim; nothing is computed here.
 */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { data } = await apiSendWithHeaders<T>(method, path, body, options);
  return data;
}

export interface ApiResponseWithHeaders<T> {
  data: T;
  /** The raw response headers — for the few endpoints that carry a signal
   *  there (P9 contract §3: `X-Schedule-Stale-Count` on every Workflow Settings
   *  PUT). Read verbatim; never derived. */
  headers: Headers;
}

/**
 * `apiSend` that also hands back the response headers. Same error contract.
 */
export async function apiSendWithHeaders<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<ApiResponseWithHeaders<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...devUserHeader() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      signal: options.signal ?? null,
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Network request failed — the API is unreachable.');
  }

  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return { data: undefined as T, headers: response.headers };
  return { data: (await response.json()) as T, headers: response.headers };
}
