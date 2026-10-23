// Typed jobs client for the LAX registry. fetch only, no runtime dependency,
// no console output. See README.md for the contract proven by tests/A1-A7.

/** Severity codes thrown as LaxJobsError.code. Values match the registry contract. */
export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

/** Job shape as returned by the registry, extra fields pass through. */
export interface Job {
  id: string;
  title: string;
  track?: string;
  summary?: string;
  spec_md?: string | null;
  skills?: string[];
  bounty_usdc?: number | null;
  currency?: string | null;
  chain?: string | null;
  deadline?: string | null;
  bid_closes?: string | null;
  status?: string | null;
  seat?: unknown;
  selection?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface SubmissionInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface Submission {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface ListJobsQuery {
  track?: string;
  limit?: number;
  offset?: number;
}

export interface JobsPage {
  jobs: Job[];
  count: number;
}

export interface CreateJobsClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Error carrying the HTTP status, the code class, and the registry message. */
export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;

  constructor(params: { status: number; code: LaxJobsErrorCode; message: string }) {
    super(params.message);
    this.name = 'LaxJobsError';
    this.status = params.status;
    this.code = params.code;
  }
}

const DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRY_DELAY_MS = 30000;
const MIN_RETRY_DELAY_MS = 500;

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._~:\/-]+$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface JobsClient {
  listJobs(query?: ListJobsQuery): Promise<JobsPage>;
  getJob(id: string): Promise<Job>;
  submit(jobId: string, input: SubmissionInput): Promise<Submission>;
}

function rejectInput(message: string): never {
  throw new LaxJobsError({ status: 0, code: 'invalid_input', message });
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RetryDelayFn = (attempt: number, retryAfter: string | null) => number;

function retryDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(MIN_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
}

function codeForHttpStatus(status: number): LaxJobsErrorCode | null {
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return null;
}

function classForHttpStatus(status: number): LaxJobsErrorCode {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function errorMessageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['detail', 'message', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return fallback;
}

function parseJsonResponse(text: string, status: number): unknown {
  if (text.trim().length === 0) throw new LaxJobsError({ status, code: 'invalid_response', message: 'The registry returned an empty body.' });
  try {
    return JSON.parse(text);
  } catch {
    throw new LaxJobsError({ status, code: 'invalid_response', message: 'The registry returned invalid JSON.' });
  }
}

function expectObject(value: unknown, message: string, status: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LaxJobsError({ status, code: 'invalid_response', message });
  }
  return value as Record<string, unknown>;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function createJobsClient(options: CreateJobsClientOptions = {}): JobsClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const injected = options.fetch ?? fetch;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? sleepDefault;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayFor: RetryDelayFn = retryDelay;

  if (!Number.isInteger(retries) || retries < 0) rejectInput('retries must be a non-negative integer.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) rejectInput('timeoutMs must be positive.');

  async function guardedFetch(url: string, init: RequestInit, kind: 'read' | 'submit'): Promise<Response> {
    const maxAttempts = 1 + Math.max(0, retries);
    let lastError: LaxJobsError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await injected(url, { ...init, signal: controller ? controller.signal : undefined });
        if (timer) clearTimeout(timer);

        if (response.ok) {
          return response;
        }
        const text = await response.text();
        const status = response.status;

        if (status === 400 || status === 404 || status === 409 || (status >= 400 && status < 500 && status !== 429)) {
          const code = codeForHttpStatus(status) ?? 'bad_request';
          const body = (() => { try { return JSON.parse(text || 'null'); } catch { return null; } })();
          throw new LaxJobsError({ status, code, message: errorMessageFrom(body, `Request rejected with HTTP ${status}.`) });
        }

        if (status === 429 || status >= 500) {
          const retryableHere = status === 429 || kind === 'read';
          const body = (() => { try { return JSON.parse(text || 'null'); } catch { return null; } })();
          lastError = new LaxJobsError({
            status,
            code: classForHttpStatus(status),
            message: errorMessageFrom(body, `Request failed with HTTP ${status}.`),
          });
          if (retryableHere && attempt < maxAttempts) {
            const delay = delayFor(attempt, response.headers.get('Retry-After'));
            await sleep(delay);
            continue;
          }
          throw lastError;
        }

        throw new LaxJobsError({ status, code: 'invalid_response', message: `Unexpected HTTP status ${status}.` });
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (error instanceof LaxJobsError) throw error;
        const networkError = new LaxJobsError({
          status: 0,
          code: 'network',
          message: error instanceof Error ? error.message : 'The registry did not answer.',
        });
        lastError = networkError;
        if (kind === 'read' && attempt < maxAttempts) {
          await sleep(delayFor(attempt, null));
          continue;
        }
        throw networkError;
      }
    }
    throw lastError ?? new LaxJobsError({ status: 0, code: 'network', message: 'The registry did not answer.' });
  }

  async function listJobs(query: ListJobsQuery = {}): Promise<JobsPage> {
    const params = new URLSearchParams();
    if (query.track !== undefined) params.set('track', query.track);
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
        rejectInput('limit must be an integer between 1 and 100.');
      }
      params.set('limit', String(query.limit));
    }
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const response = await guardedFetch(buildUrl(baseUrl, `/jobs${suffix}`), { method: 'GET' }, 'read');
    const body = expectObject(parseJsonResponse(await response.text(), response.status), 'listJobs expected a JSON object.', response.status);
    const jobsRaw = body.jobs;
    if (!Array.isArray(jobsRaw)) {
      throw new LaxJobsError({ status: response.status, code: 'invalid_response', message: 'listJobs expected a jobs array.' });
    }
    const count = body.count;
    if (typeof count !== 'number') {
      throw new LaxJobsError({ status: response.status, code: 'invalid_response', message: 'listJobs expected a count number.' });
    }
    return { jobs: jobsRaw as Job[], count };
  }

  async function getJob(id: string): Promise<Job> {
    if (typeof id !== 'string' || id.trim().length === 0) rejectInput('getJob expects a non-empty id.');
    const response = await guardedFetch(buildUrl(baseUrl, `/jobs/${encodeURIComponent(id)}`), { method: 'GET' }, 'read');
    const body = expectObject(parseJsonResponse(await response.text(), response.status), 'getJob expected a JSON object.', response.status);
    const job = body.job;
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      throw new LaxJobsError({ status: response.status, code: 'invalid_response', message: 'getJob expected a job object.' });
    }
    return job as Job;
  }

  async function submit(jobId: string, input: SubmissionInput): Promise<Submission> {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) rejectInput('submit expects a non-empty job id.');
    if (!input || typeof input !== 'object') throw rejectInput('submit expects a submission object.');
    if (typeof input.builder !== 'string' || input.builder.trim().length === 0) rejectInput('builder is required.');
    if (typeof input.contact !== 'string' || input.contact.trim().length === 0) rejectInput('contact is required.');
    if (typeof input.agent_did !== 'string' || !DID_PATTERN.test(input.agent_did)) rejectInput('agent_did must look like did:method:identifier.');
    if (typeof input.payout_address !== 'string' || !EVM_ADDRESS_PATTERN.test(input.payout_address)) rejectInput('payout_address must be a 0x address with 40 hex characters.');
    if (typeof input.repo_or_patch_url !== 'string' || !/^https:\/\//i.test(input.repo_or_patch_url)) rejectInput('repo_or_patch_url must be an https URL.');
    try { if (new URL(input.repo_or_patch_url).protocol !== 'https:') rejectInput('HTTPS required.'); } catch { rejectInput('repo_or_patch_url must be a valid HTTPS URL.'); }
    if (input.notes !== undefined && typeof input.notes !== 'string') rejectInput('notes must be a string when present.');

    const url = buildUrl(baseUrl, `/jobs/${encodeURIComponent(jobId)}/submissions`);
    const payload: Record<string, unknown> = {
      builder: input.builder,
      contact: input.contact,
      repo_or_patch_url: input.repo_or_patch_url,
      payout_address: input.payout_address,
      agent_did: input.agent_did,
    };
    if (input.notes !== undefined) payload.notes = input.notes;
    const response = await guardedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 'submit');
    const body = expectObject(parseJsonResponse(await response.text(), response.status), 'submit expected a JSON object.', response.status);
    const submission = body.submission;
    if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
      throw new LaxJobsError({ status: response.status, code: 'invalid_response', message: 'submit expected a submission object.' });
    }
    return submission as Submission;
  }

  return { listJobs, getJob, submit };
}
