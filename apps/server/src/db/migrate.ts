import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";
import { seedAiActions } from "./seed-ai.js";

// dist/db/migrate.js -> ../../drizzle  |  src/db/migrate.ts (via tsx) -> ../../drizzle
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await seedIdempotent(db);
}

async function seedIdempotent(db: Db): Promise<void> {
  await seedAiActions(db);
}
