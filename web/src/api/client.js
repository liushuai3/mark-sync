const BASE = '/api';
const HEALTH = '/health';

let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function request(path, opts = {}) {
  const token = localStorage.getItem('jwt');
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!json.ok) {
    if (res.status === 401) onUnauthorized();
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.code = json.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

export async function health() {
  const res = await fetch(HEALTH);
  const json = await res.json();
  return json.data;
}
