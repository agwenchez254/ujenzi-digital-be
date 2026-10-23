const SECRET_VARS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CSRF_SECRET'] as const;
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /replace-with|changeme|change-me|example|secret$/i;

/**
 * Refuses to boot in production with signing secrets that are missing, short, left at
 * their .env.example placeholder, or reused between purposes. Reusing the access and
 * refresh secret would let a refresh token pass as an access token.
 */
export function assertSecureConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  for (const name of SECRET_VARS) {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    } else if (PLACEHOLDER.test(value)) {
      problems.push(`${name} still looks like a placeholder`);
    }
  }
  const values = SECRET_VARS.map((name) => env[name]).filter(Boolean);
  if (new Set(values).size !== values.length) {
    problems.push(`${SECRET_VARS.join(', ')} must all be different from each other`);
  }

  if (problems.length) {
    throw new Error(`Insecure configuration:\n - ${problems.join('\n - ')}`);
  }
}
