import { db, rawScheduleStagingTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

const PBS_API_BASE_URL = "https://data-api.health.gov.au/pbs/api/v3";
const PBS_API_ORIGIN = new URL(PBS_API_BASE_URL).origin;
const PBS_API_PATH_PREFIX = new URL(PBS_API_BASE_URL).pathname;
const MIN_REQUEST_GAP_MS = 20_000;
// The PBS API accepted limit=100000 for the documented N06BA relationship query.
const DEFAULT_PAGE_SIZE = 100_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_PAGES_PER_ENDPOINT = 10_000;
const DEFAULT_ENDPOINTS = ["items"];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type RequestLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface FetchScheduleOptions {
  scheduleDate: string;
  endpoints?: string[];
  limit?: number;
  maxRetries?: number;
  maxPagesPerEndpoint?: number;
  maxPages?: number;
  filters?: PbsRequestFilter[];
  coverageScope?: "filtered" | "schedule";
  latestScheduleOnly?: boolean;
  request?: RequestLike;
  sleep?: Sleep;
  onPage?: (page: FetchedSchedulePage) => void | Promise<void>;
  onPayload?: (page: FetchedSchedulePayload) => void | Promise<void>;
}

export interface PbsRequestFilter {
  requestKey: string;
  params: Record<string, string>;
  endpoint?: string;
}

export interface FetchedSchedulePage {
  endpoint: string;
  requestKey: string;
  pageNumber: number;
  records: number;
  url: string;
}

export interface FetchedSchedulePayload extends FetchedSchedulePage {
  payload: JsonValue;
}

interface PaginationInfo {
  hasMore: boolean;
  nextUrl?: string;
}

interface RequestPolicy {
  nextRequestAt: number;
}

const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sharedRequestPolicy: RequestPolicy = { nextRequestAt: 0 };

function isObject(value: JsonValue | unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseDelayHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  // Rate-limit reset headers are commonly either seconds from now or Unix seconds.
  if (parsed >= 1_000_000_000) return Math.max(0, parsed * 1_000 - Date.now());
  return parsed * 1_000;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function normaliseEndpoint(endpoint: string): string {
  const normalised = endpoint.trim().replace(/^\/+|\/+$/g, "");
  if (!normalised) throw new Error("PBS endpoint cannot be empty");
  if (normalised.includes("://")) throw new Error("PBS endpoints must be relative to the configured PBS API base URL");
  return normalised;
}

export function buildPageUrl(
  endpoint: string,
  pageNumber: number,
  limit: number,
  params: Record<string, string> = {},
  latestScheduleOnly = true,
): URL {
  const url = new URL(`${PBS_API_BASE_URL}/${normaliseEndpoint(endpoint)}`);
  url.searchParams.set("get_latest_schedule_only", String(latestScheduleOnly));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("page", String(pageNumber));
  url.searchParams.set("limit", String(limit));
  return url;
}

function getCollectionLength(payload: JsonValue): number {
  if (Array.isArray(payload)) return payload.length;
  if (!isObject(payload)) return 0;

  for (const key of ["data", "items", "results", "records"]) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  return 0;
}

function findNextUrl(payload: JsonValue): string | undefined {
  if (!isObject(payload)) return undefined;

  const links = isObject(payload.links) ? payload.links : undefined;
  const apiLinks = Array.isArray(payload._links) ? payload._links : undefined;
  const pagination = isObject(payload.pagination) ? payload.pagination : undefined;
  const meta = isObject(payload.meta) ? payload.meta : undefined;
  const apiMeta = isObject(payload._meta) ? payload._meta : undefined;
  const metaPagination = meta && isObject(meta.pagination) ? meta.pagination : undefined;

  for (const candidate of [payload.next, links?.next, pagination?.next, meta?.next, metaPagination?.next]) {
    const next = asString(candidate);
    if (next) return next;
  }

  for (const link of apiLinks ?? []) {
    if (!isObject(link) || link.rel !== "next") continue;
    const next = asString(link.href);
    if (next) return next;
  }
  return undefined;
}

function getPaginationInfo(payload: JsonValue, pageNumber: number, limit: number): PaginationInfo {
  const nextUrl = findNextUrl(payload);
  if (nextUrl) return { hasMore: true, nextUrl };

  if (!isObject(payload)) {
    return { hasMore: Array.isArray(payload) && payload.length >= limit };
  }

  const pagination = isObject(payload.pagination) ? payload.pagination : undefined;
  const meta = isObject(payload.meta) ? payload.meta : undefined;
  const apiMeta = isObject(payload._meta) ? payload._meta : undefined;
  const metaPagination = meta && isObject(meta.pagination) ? meta.pagination : undefined;
  const pageInfo = pagination ?? metaPagination ?? meta ?? apiMeta;

  const currentPage = asNumber(pageInfo?.page) ?? asNumber(pageInfo?.current_page) ?? asNumber(pageInfo?.currentPage) ?? pageNumber;
  const totalPages = asNumber(pageInfo?.total_pages) ?? asNumber(pageInfo?.totalPages);
  if (totalPages !== undefined) return { hasMore: currentPage < totalPages };

  const hasNext = pageInfo?.has_next ?? pageInfo?.hasNext ?? payload.has_next ?? payload.hasNext;
  if (typeof hasNext === "boolean") return { hasMore: hasNext };

  const total = asNumber(pageInfo?.total) ?? asNumber(pageInfo?.total_records) ?? asNumber(meta?.total);
  if (total !== undefined) return { hasMore: currentPage * limit < total };

  return { hasMore: getCollectionLength(payload) >= limit };
}

function resolveNextUrl(nextUrl: string): URL {
  const resolved = /^https?:\/\//i.test(nextUrl)
    ? new URL(nextUrl)
    : nextUrl.startsWith("/api/v3/")
      ? new URL(`/pbs${nextUrl}`, PBS_API_ORIGIN)
      : new URL(nextUrl, `${PBS_API_BASE_URL}/`);

  if (
    resolved.protocol !== "https:" ||
    resolved.origin !== PBS_API_ORIGIN ||
    !resolved.pathname.startsWith(`${PBS_API_PATH_PREFIX}/`)
  ) {
    throw new Error("PBS API returned a pagination link outside the configured PBS API");
  }

  return resolved;
}

function updateRequestPolicy(policy: RequestPolicy, response: Response): void {
  const now = Date.now();
  policy.nextRequestAt = Math.max(policy.nextRequestAt, now + MIN_REQUEST_GAP_MS);

  const remaining = parsePositiveInteger(response.headers.get("x-rate-limit-remaining"));
  const resetDelay = parseDelayHeader(response.headers.get("x-rate-limit-reset"));
  if (remaining === 0 && resetDelay !== undefined) {
    policy.nextRequestAt = Math.max(policy.nextRequestAt, now + resetDelay);
  }
}

async function waitForRequestSlot(policy: RequestPolicy, sleep: Sleep): Promise<void> {
  const delay = policy.nextRequestAt - Date.now();
  if (delay > 0) await sleep(delay);
}

async function fetchPage(
  url: URL,
  apiKey: string,
  policy: RequestPolicy,
  maxRetries: number,
  request: RequestLike,
  sleep: Sleep,
): Promise<JsonValue> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForRequestSlot(policy, sleep);

    let response: Response;
    try {
      response = await request(url, {
        headers: {
          Accept: "application/json",
          "Subscription-Key": apiKey,
        },
      });
    } catch (error) {
      policy.nextRequestAt = Math.max(policy.nextRequestAt, Date.now() + MIN_REQUEST_GAP_MS);
      if (attempt === maxRetries) throw error;
      await sleep(Math.min(300_000, 1_000 * 2 ** attempt));
      continue;
    }

    updateRequestPolicy(policy, response);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      const exponentialDelay = Math.min(300_000, 1_000 * 2 ** attempt);
      const retryAfterDelay = parseRetryAfter(response.headers.get("retry-after")) ?? 0;
      policy.nextRequestAt = Math.max(policy.nextRequestAt, Date.now() + retryAfterDelay);
      await sleep(Math.max(exponentialDelay, retryAfterDelay));
      continue;
    }

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`PBS API request failed (${response.status}) for ${url.pathname}: ${responseText.slice(0, 500)}`);
    }

    if (response.status === 204) {
      return { data: [] };
    }

    return (await response.json()) as JsonValue;
  }

  throw new Error(`PBS API request exhausted retries for ${url.pathname}`);
}

/**
 * Fetches every page for the configured PBS schedule endpoints.
 *
 * The response is inserted into raw_schedule_staging immediately after JSON
 * decoding and before any domain-specific parsing or upsert logic. This
 * function intentionally does not parse or mutate PBS reference tables; that
 * belongs to the later ingestion phase.
 */
export async function fetchSchedule(options: FetchScheduleOptions): Promise<FetchedSchedulePage[]> {
  const {
    scheduleDate,
    endpoints = DEFAULT_ENDPOINTS,
    limit = DEFAULT_PAGE_SIZE,
    maxRetries = DEFAULT_MAX_RETRIES,
    maxPagesPerEndpoint = DEFAULT_MAX_PAGES_PER_ENDPOINT,
    maxPages,
    filters = [{ requestKey: "unfiltered", params: {} }],
    coverageScope = "filtered",
    latestScheduleOnly = true,
    request = fetch,
    sleep = defaultSleep,
    onPage,
    onPayload,
  } = options;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) {
    throw new Error("scheduleDate must use YYYY-MM-DD format");
  }
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer");
  if (!Number.isInteger(maxPagesPerEndpoint) || maxPagesPerEndpoint <= 0) {
    throw new Error("maxPagesPerEndpoint must be a positive integer");
  }
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    throw new Error("maxPages must be a positive integer");
  }
  if (filters.length === 0) throw new Error("At least one PBS request filter is required");
  for (const filter of filters) {
    if (!/^[a-z0-9][a-z0-9:_-]{0,120}$/i.test(filter.requestKey)) {
      throw new Error("PBS request keys must contain only letters, numbers, colons, underscores, or hyphens");
    }
  }

  const apiKey = process.env.PBS_SUBSCRIPTION_KEY;
  if (!apiKey) {
    throw new Error("PBS_SUBSCRIPTION_KEY is not configured in Replit Secrets");
  }

  const fetchedPages: FetchedSchedulePage[] = [];

  for (const filter of filters) {
    for (const configuredEndpoint of filter.endpoint ? [filter.endpoint] : endpoints) {
      const endpoint = normaliseEndpoint(configuredEndpoint);
      let pageNumber = 1;
      let nextUrl: URL | undefined;

      while (true) {
        if (pageNumber > maxPagesPerEndpoint) {
          throw new Error(`PBS endpoint ${endpoint} exceeded the ${maxPagesPerEndpoint}-page safety limit`);
        }

        const url = nextUrl ?? buildPageUrl(endpoint, pageNumber, limit, filter.params, latestScheduleOnly);
        logger.info(
          { endpoint, requestKey: filter.requestKey, pageNumber, url: url.toString() },
          "Requesting PBS schedule page",
        );
        const payload = await fetchPage(url, apiKey, sharedRequestPolicy, maxRetries, request, sleep);

        // Persist the untouched API page before interpreting its records.
        await db
          .insert(rawScheduleStagingTable)
          .values({
            scheduleDate,
            endpoint,
            requestKey: filter.requestKey,
            pageNumber,
            coverageScope,
            payload,
          })
          .onConflictDoNothing();

        const page = {
          endpoint,
          requestKey: filter.requestKey,
          pageNumber,
          records: getCollectionLength(payload),
          url: url.toString(),
        };
        fetchedPages.push(page);
        await onPage?.(page);
        await onPayload?.({ ...page, payload });

        if (maxPages !== undefined && fetchedPages.length >= maxPages) {
          return fetchedPages;
        }

        const pagination = getPaginationInfo(payload, pageNumber, limit);
        if (!pagination.hasMore) break;
        pageNumber += 1;
        nextUrl = pagination.nextUrl ? resolveNextUrl(pagination.nextUrl) : undefined;
      }

      if (coverageScope === "schedule") {
        await db
          .update(rawScheduleStagingTable)
          .set({ coverageComplete: true })
          .where(
            and(
              eq(rawScheduleStagingTable.scheduleDate, scheduleDate),
              eq(rawScheduleStagingTable.endpoint, endpoint),
              eq(rawScheduleStagingTable.requestKey, filter.requestKey),
            ),
          );
      }
    }
  }

  return fetchedPages;
}