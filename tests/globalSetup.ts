import { execSync } from "node:child_process";

/** Rebuilds the local test database from the migrations before the run. */
export default function setup() {
  execSync("./scripts/local-db.sh intheanswer_test", { stdio: "inherit" });
}
