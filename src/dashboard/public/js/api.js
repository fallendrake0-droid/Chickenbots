export class ApiError extends Error {
  constructor(message, { status = 0, code = null, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body = null, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin'
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = { ok: false, error: text.slice(0, 300) }; }
    }
    if (!response.ok) {
      throw new ApiError((payload && payload.error) || `request failed (${response.status})`, {
        status: response.status,
        code: payload && payload.code,
        payload
      });
    }
    return payload;
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('request timed out', { code: 'TIMEOUT' });
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'network error', { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  state: () => request('/api/state'),
  health: () => request('/healthz', { timeoutMs: 5000 }),
  commands: () => request('/api/commands'),
  execute: (line, { confirm = false, operator = 'dashboard' } = {}) =>
    request('/api/command', { method: 'POST', body: { line, confirm, operator }, timeoutMs: 120000 }),
  logs: (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    return request(`/api/logs?${query.toString()}`, { timeoutMs: 10000 });
  },
  settings: () => request('/api/settings'),
  schematics: (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    return request(`/api/schematics?${query.toString()}`, { timeoutMs: 20000 });
  },
  schematic: (id) => request(`/api/schematics/${encodeURIComponent(id)}`, { timeoutMs: 30000 }),
  botAction: (name, action) => request(`/api/bot/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: 'POST', body: {}, timeoutMs: 120000 })
};
