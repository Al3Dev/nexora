import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().optional(),
    /** Local-only embedded PostgreSQL directory, used when DATABASE_URL is unset. */
    PGLITE_DATA_DIR: z.string().default('./.data/pglite'),
    /** HS256 secret used to verify access tokens (e.g. the Supabase project JWT secret). */
    AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),
    AUTH_JWT_ISSUER: z.string().optional(),
    AUTH_JWT_AUDIENCE: z.string().optional(),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
  })
  .refine((c) => c.NODE_ENV !== 'production' || !!c.DATABASE_URL, {
    message: 'DATABASE_URL is required in production',
    path: ['DATABASE_URL'],
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
