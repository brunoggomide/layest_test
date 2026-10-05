import { InvalidEnvError, loadEnv, placeholderWarnings, type Env } from './config/env.js';
import { buildApp } from './http/app.js';
import { createDatabase } from './infrastructure/db/database.js';

const SHUTDOWN_GRACE_MS = 10_000;

function readEnv(): Env {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof InvalidEnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const database = createDatabase(env);
  const app = buildApp({ env, database });
  for (const warning of placeholderWarnings(env)) app.log.warn(warning);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

await main();
