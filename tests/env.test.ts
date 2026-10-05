import { describe, expect, it } from 'vitest';
import { InvalidEnvError, loadEnv, placeholderWarnings } from '../src/config/env.js';

const VALID = {
  BILLAY_APP_PASSWORD: 'app-password-0123',
  BILLAY_SERVICE_PASSWORD: 'service-password-0123',
  SERVICE_TOKEN: 'service-token-0123456789',
};

describe('configuration', () => {
  it('names every missing or too short secret instead of starting', () => {
    expect(() => loadEnv({})).toThrow(InvalidEnvError);
    try {
      loadEnv({ ...VALID, SERVICE_TOKEN: 'short' });
    } catch (error) {
      expect((error as InvalidEnvError).issues.join(' ')).toMatch(/SERVICE_TOKEN/);
    }
  });

  it('treats an empty value as unset and applies defaults', () => {
    const env = loadEnv({ ...VALID, PORT: '', DATABASE_NAME: '' });
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_NAME).toBe('billay');
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it('warns about every .env.example placeholder still in use, and about nothing else', () => {
    const clean = loadEnv(VALID);
    expect(placeholderWarnings(clean)).toEqual([]);
    const placeholders = loadEnv({ ...VALID, SERVICE_TOKEN: 'change-me-service-token', POSTGRES_PASSWORD: 'change-me-admin' });
    expect(placeholderWarnings(placeholders).map((w) => w.split(' ')[0])).toEqual(['POSTGRES_PASSWORD', 'SERVICE_TOKEN']);
  });
});
