export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** Seconds until a locked-out action may be retried. */
  get retryAfter(): number | null {
    return typeof this.data.retryAfter === 'number' ? this.data.retryAfter : null;
  }
}

type Json = Record<string, unknown> | unknown[] | undefined;

const SIGN_IN_FLOW = /^\/api\/auth\/(login|mfa|me|passkey(\/|$))/;

async function request<T>(method: string, url: string, body?: Json | FormData): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: Record<string, any> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    // A 401 from the sign-in flow itself is a wrong code, not an expired login.
    if (res.status === 401 && !SIGN_IN_FLOW.test(url)) window.dispatchEvent(new Event('cloude:unauthorized'));
    throw new ApiError(res.status, data.error ?? res.statusText, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: Json | FormData) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: Json) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: Json) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};
