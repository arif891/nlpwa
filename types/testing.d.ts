/**
 * Test helpers for simulating Service Worker environments in Node.js.
 */
export function setupEnv(
  fetchImpl: (req: Request) => Promise<Response> | Response,
  config?: Record<string, any>
): any;

export function req(path: string, init?: RequestInit): Request;

export function fakeEvent(): {
  waitUntil: (promise: Promise<any>) => void;
  settle: () => Promise<PromiseSettledResult<any>[]>;
};

export function sleep(ms: number): Promise<void>;
