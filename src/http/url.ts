/**
 * Query serialization and URL building.
 *
 * Copied from funnelchat-node, branch feat/inicial @ de14b86, src/core/url.ts (unchanged, minus the
 * `QueryValue` type): Laravel reads `key[]=a&key[]=b`, booleans as `1`/`0`, dates as ISO 8601.
 */

/**
 * Serializes a query object the way Laravel reads it:
 *
 * - arrays as `key[]=a&key[]=b` (a key already written as `key[]` is not doubled);
 * - nested objects with brackets: `filters[0][mode]=all`;
 * - booleans as `1` / `0` (Laravel's `boolean` rule rejects the strings `true` / `false`);
 * - dates as ISO 8601;
 * - `null` and `undefined` are left out.
 */
export function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) append(params, key, value);
  return params.toString();
}

function append(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    const scalarKey = key.endsWith('[]') ? key : `${key}[]`;
    const base = key.endsWith('[]') ? key.slice(0, -2) : key;
    value.forEach((item, index) => {
      if (isPlainObject(item) || Array.isArray(item)) append(params, `${base}[${index}]`, item);
      else append(params, scalarKey, item);
    });
    return;
  }
  if (value instanceof Date) {
    params.append(key, value.toISOString());
    return;
  }
  if (isPlainObject(value)) {
    for (const [child, childValue] of Object.entries(value)) append(params, `${key}[${child}]`, childValue);
    return;
  }
  if (typeof value === 'boolean') {
    params.append(key, value ? '1' : '0');
    return;
  }
  params.append(key, String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Replaces `{name}` placeholders of a path template with URL-encoded values.
 * Throws when a placeholder has no value, so a request never goes out with `{contact}` in it.
 */
export function interpolatePath(template: string, params: Record<string, unknown> | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`Missing the path parameter "${name}" for ${template}.`);
    }
    return encodeURIComponent(String(value));
  });
}

/** Joins the base URL and a path (`/api/v1/...`) without doubling or losing slashes. */
export function joinUrl(baseUrl: string, path: string, query: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (!query) return `${base}${suffix}`;
  return `${base}${suffix}${suffix.includes('?') ? '&' : '?'}${query}`;
}
