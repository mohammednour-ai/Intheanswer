import { rebuildDatabase } from "../scripts/rebuild-db";

/**
 * Rebuilds the test database from the migrations before the run. The database
 * rebuilt is the one named in TEST_DATABASE_URL (default intheanswer_test on
 * localhost), the same one the tests then use, and its name must contain
 * "test": the suite truncates tables, so it must never see another database.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/intheanswer_test";
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.includes("test")) throw new Error(`refusing to rebuild "${name}": the test database name must contain "test"`);
  await rebuildDatabase(url);
}
