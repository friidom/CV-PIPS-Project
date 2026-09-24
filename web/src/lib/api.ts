import type { JobProgress, JobResult, ServerCapabilities } from "./types";

/** Empty in production (same origin as server/app.py); set for a split deployment. */
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export const api = (path: string): string => `${BASE}${path}`;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    /* not JSON — fall through to the status text */
  }
  return res.statusText || `request failed (${res.status})`;
}

export async function getCapabilities(signal?: AbortSignal): Promise<ServerCapabilities> {
  const res = await fetch(api("/api/capabilities"), { signal });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as ServerCapabilities;
}

export async function submitVideo(file: File, signal?: AbortSignal): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(api("/api/jobs"), { method: "POST", body: form, signal });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as { id: string };
}

export async function getJob(id: string, signal?: AbortSignal): Promise<JobProgress | JobResult> {
  const res = await fetch(api(`/api/jobs/${id}`), { signal });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as JobProgress | JobResult;
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(api(`/api/jobs/${id}`), { method: "DELETE" }).catch(() => undefined);
}

/**
 * Server-sent progress for one job. Returns an unsubscribe function.
 * The caller still polls as a safety net: some proxies buffer SSE indefinitely.
 */
export function streamJob(
  id: string,
  onUpdate: (p: JobProgress | JobResult) => void,
  onError: (e: Error) => void,
): () => void {
  const source = new EventSource(api(`/api/jobs/${id}/stream`));
  source.onmessage = (ev) => {
    try {
      onUpdate(JSON.parse(ev.data) as JobProgress | JobResult);
    } catch {
      /* a truncated frame is not fatal; the next one supersedes it */
    }
  };
  source.onerror = () => {
    source.close();
    onError(new Error("progress stream closed"));
  };
  return () => source.close();
}

/** Static site data under web/public/data. Returns null when the asset is absent. */
export async function loadData<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${path}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
