import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createJobsClient, LaxJobsError } from '../src/jobs';

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function queueFetch(items: Array<Response | Error | ((url: string, init?: RequestInit) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const next = items.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    if (!next) throw new Error('no queued response');
    return next;
  };
  return { fetcher: fetcher as typeof fetch, calls };
}

const validSubmission = {
  builder: 'Mave',
  contact: 'operator@example.test',
  repo_or_patch_url: 'https://github.com/mave/lax/commit/0123456789012345678901234567890123456789',
  payout_address: '0xbDD0C39493307e863d67884171449E3463B7a426',
  agent_did: 'did:web:mave-lax-host.marenjeamar4734.workers.dev',
  notes: 'Tests A1 through A7 pass.',
};

describe('LAX jobs client acceptance', () => {
  test('A1 listJobs, getJob and submit send the specified requests and return parsed answers', async () => {
    const q = queueFetch([
      json({ jobs: [{ id: 'j1', title: 'one' }], count: 1 }),
      json({ job: { id: 'j/2', title: 'two' } }),
      json({ submission: { id: 's1', job_id: 'j1', status: 'received', created_at: '2026-10-23T00:00:00Z' } }, 201),
    ]);
    const client = createJobsClient({ baseUrl: 'https://registry.test/root/', fetch: q.fetcher, sleep: async () => {} });
    expect(await client.listJobs({ track: 'sdk', limit: 20, offset: 3 })).toEqual({ jobs: [{ id: 'j1', title: 'one' }], count: 1 });
    expect(await client.getJob('j/2')).toEqual({ id: 'j/2', title: 'two' });
    expect(await client.submit('j1', validSubmission)).toEqual({ id: 's1', job_id: 'j1', status: 'received', created_at: '2026-10-23T00:00:00Z' });

    expect(q.calls[0].url).toBe('https://registry.test/root/jobs?track=sdk&limit=20&offset=3');
    expect(q.calls[0].init?.method).toBe('GET');
    expect(q.calls[1].url).toBe('https://registry.test/root/jobs/j%2F2');
    expect(q.calls[2].url).toBe('https://registry.test/root/jobs/j1/submissions');
    expect(q.calls[2].init?.method).toBe('POST');
    expect(new Headers(q.calls[2].init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(q.calls[2].init?.body))).toEqual(validSubmission);
  });

  test('A2 400, 404 and 409 throw one typed LaxJobsError with the registry message', async () => {
    for (const [status, code] of [[400, 'bad_request'], [404, 'not_found'], [409, 'conflict']] as const) {
      const q = queueFetch([json({ error: `registry-${status}` }, status)]);
      const client = createJobsClient({ fetch: q.fetcher, retries: 9, sleep: async () => {} });
      try {
        await client.getJob('one');
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(LaxJobsError);
        expect((error as LaxJobsError).status).toBe(status);
        expect((error as LaxJobsError).code).toBe(code);
        expect((error as LaxJobsError).message).toBe(`registry-${status}`);
      }
      expect(q.calls).toHaveLength(1);
    }
  });

  test('A3 429 honors Retry-After, succeeds after retry, and ends as rate_limited', async () => {
    const sleeps: number[] = [];
    const q = queueFetch([
      json({ error: 'slow down' }, 429, { 'Retry-After': '45' }),
      json({ jobs: [], count: 0 }),
    ]);
    const client = createJobsClient({ fetch: q.fetcher, retries: 2, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await client.listJobs()).toEqual({ jobs: [], count: 0 });
    expect(sleeps).toEqual([30000]);

    const terminal = queueFetch([
      json({ message: 'again' }, 429),
      json({ message: 'again' }, 429),
      json({ message: 'last' }, 429),
    ]);
    const terminalSleeps: number[] = [];
    const terminalClient = createJobsClient({ fetch: terminal.fetcher, retries: 2, sleep: async (ms) => { terminalSleeps.push(ms); } });
    await expect(terminalClient.getJob('j')).rejects.toMatchObject({ status: 429, code: 'rate_limited', message: 'last' });
    expect(terminalSleeps).toEqual([500, 1000]);
  });

  test('A4 reads retry 5xx and network errors; submit does not retry them', async () => {
    const q = queueFetch([
      json({ error: 'server' }, 503),
      new Error('socket closed'),
      json({ job: { id: 'j', title: 'recovered' } }),
    ]);
    const sleeps: number[] = [];
    const client = createJobsClient({ fetch: q.fetcher, retries: 2, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await client.getJob('j')).toEqual({ id: 'j', title: 'recovered' });
    expect(sleeps).toEqual([500, 1000]);

    const submit5xx = queueFetch([json({ error: 'do not retry' }, 503), json({ submission: {} }, 201)]);
    const submitClient = createJobsClient({ fetch: submit5xx.fetcher, retries: 3, sleep: async () => {} });
    await expect(submitClient.submit('j', validSubmission)).rejects.toMatchObject({ status: 503, code: 'server' });
    expect(submit5xx.calls).toHaveLength(1);

    const submitNetwork = queueFetch([new Error('offline'), json({ submission: {} }, 201)]);
    const networkClient = createJobsClient({ fetch: submitNetwork.fetcher, retries: 3, sleep: async () => {} });
    await expect(networkClient.submit('j', validSubmission)).rejects.toMatchObject({ status: 0, code: 'network' });
    expect(submitNetwork.calls).toHaveLength(1);
  });

  test('A5 submit validates DID, payout address and https URL before fetch', async () => {
    const q = queueFetch([]);
    const client = createJobsClient({ fetch: q.fetcher });
    for (const input of [
      { ...validSubmission, agent_did: '' },
      { ...validSubmission, payout_address: '0x1234' },
      { ...validSubmission, repo_or_patch_url: 'http://example.test/patch' },
    ]) {
      await expect(client.submit('j', input)).rejects.toMatchObject({ status: 0, code: 'invalid_input' });
    }
    expect(q.calls).toHaveLength(0);
  });

  test('A6 client has no console output and adds no runtime dependency', () => {
    const source = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
    expect(source).not.toMatch(/^\s*import\s+.*from\s+['"][^./]/m);
    expect(source).not.toMatch(/require\s*\(/);
  });

  const live = process.env.LAX_LIVE === '1' ? test : test.skip;
  live('A7 live integration reads GET /jobs only when LAX_LIVE=1', async () => {
    const client = createJobsClient();
    const page = await client.listJobs({ limit: 1 });
    expect(Array.isArray(page.jobs)).toBe(true);
    expect(typeof page.count).toBe('number');
  });
});
