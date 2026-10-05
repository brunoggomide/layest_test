import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/db/database.js';
import { runPromotion } from '../src/internal/promotion/promote.js';
import { formatPromotionReport } from '../src/internal/promotion/report.js';

const env = loadEnv();
const database = createDatabase(env);
try {
  const report = await database.withService((db) => runPromotion(db, env.PROMOTION_MIN_TENANTS));
  console.log(formatPromotionReport(report).join('\n'));
} finally {
  await database.close();
}
