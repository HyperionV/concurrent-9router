export function asBool(value) {
  return value ? 1 : 0;
}

export function fromBool(value) {
  return value === 1 || value === true;
}

export function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

export function nowIso() {
  return new Date().toISOString();
}
