// Used when FRONTEND_ORIGIN is not configured at all.
const DEFAULT_ORIGINS = [
  'http://localhost:8080',
  'http://localhost:8081',
  'http://localhost:5173',
  'http://localhost:3000',
];

// Always allowed so local development works against any deployment.
const ALWAYS_ALLOWED = ['http://localhost:8080', 'http://localhost:5173', 'http://localhost:8081'];

/**
 * Browser origins permitted to call the API and open sockets. FRONTEND_ORIGIN is a
 * comma-separated list.
 */
export function resolveAllowedOrigins(raw: string | undefined): string[] {
  const configured = raw
    ? raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
  const base = configured.length ? configured : DEFAULT_ORIGINS;
  return [...new Set([...base, ...ALWAYS_ALLOWED])];
}
