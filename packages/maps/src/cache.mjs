class TtlCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return value;
    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
    return value;
  }

  clear() {
    this.entries.clear();
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const defaultMapsCache = new TtlCache();

export {
  TtlCache,
  defaultMapsCache,
  stableJson,
};
