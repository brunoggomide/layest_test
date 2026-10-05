import { z } from 'zod';

const schema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_HOST: z.string().min(1).default('localhost'),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().min(1).default('billay'),
  /** Superuser for migrate, seed and reset. Optional so the API can run without ever holding it. */
  POSTGRES_USER: z.string().min(1).default('postgres'),
  POSTGRES_PASSWORD: z.string().min(8).optional(),
  BILLAY_APP_PASSWORD: z.string().min(12),
  BILLAY_SERVICE_PASSWORD: z.string().min(12),
  /** Shared secret of the platform reviewer scope: the MVP stand-in for real authentication. */
  SERVICE_TOKEN: z.string().min(16),
  PROMOTION_MIN_TENANTS: z.coerce.number().int().min(2).default(3),
});

export type Env = Readonly<z.infer<typeof schema>>;

export class InvalidEnvError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid configuration: ${issues.join('; ')}`);
    this.name = 'InvalidEnvError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An empty value in a .env file means "unset", not an empty string to validate.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new InvalidEnvError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  return parsed.data;
}

const SECRETS = ['POSTGRES_PASSWORD', 'BILLAY_APP_PASSWORD', 'BILLAY_SERVICE_PASSWORD', 'SERVICE_TOKEN'] as const;

/** The .env.example placeholders are long enough to pass validation, which is exactly why they must be called out. */
export function placeholderWarnings(env: Env): string[] {
  return SECRETS.filter((name) => /change-me/i.test(env[name] ?? '')).map((name) => `${name} still holds the .env.example placeholder; replace it before anyone else can reach this instance`);
}
