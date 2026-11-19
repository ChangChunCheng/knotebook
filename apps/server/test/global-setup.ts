import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// vitest's default forks pool runs each test file in an independent process per worker, so globalThis isn't shared. globalSetup (running in the vitest main process)
// writes the connection string into process.env; workers forked afterwards inherit that env, so child processes can read TEST_DATABASE_URL.
export default async function setup(): Promise<() => Promise<void>> {
  // Overrides testcontainers' default CMD-SHELL healthcheck: when the machine is busy it times out and leaves an orphan pg_isready, whose exit 2 the postmaster
  // treats as a backend crash and restarts the whole cluster (57P03). Uses the CMD form (no shell) with a looser timeout.
  // User and database keep the defaults (test/test); `--host localhost` is kept to go over TCP (avoiding the false readiness of the unix socket during initdb).
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withHealthCheck({
      test: ["CMD", "pg_isready", "--host", "localhost", "--username", "test", "--dbname", "test"],
      interval: 1000,
      timeout: 5000,
      retries: 120,
    })
    .start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();

  return async () => {
    await container.stop();
  };
}
