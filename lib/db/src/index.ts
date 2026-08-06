import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
export {
  SECOND_TIER_TICKERS,
  SMART_MONEY_EXTRA_TICKERS,
  SMART_MONEY_TICKERS,
} from "./market-universe";
export type { SecondTierTicker, SmartMoneyTicker } from "./market-universe";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
