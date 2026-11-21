import * as os from 'node:os';
import { buildApp } from '../src/app.js';
import { createDatabaseContext } from '../src/db/client.js';
import { runMigrationsToLatest } from '../src/db/migrator.js';
import { startMockOidcBoundaryServer } from '../tests/helpers/oidc-boundary-mock.js';
import { startIsolatedPostgresCluster } from '../tests/helpers/postgres-harness.js';
import {
  authenticateTestUser,
  buildTestConfig,
  TEST_GOOGLE_CLIENT_ID,
} from '../tests/helpers/test-app.js';

interface SeededAccountFixture {
  accessToken: string;
  projectIds: string[];
  artifactIdsByProject: Map<string, string[]>;
}

function computePercentile(sortedLatenciesMs: number[], percentile: number): number {
  if (sortedLatenciesMs.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedLatenciesMs.length - 1,
    Math.ceil((percentile / 100) * sortedLatenciesMs.length) - 1,
  );
  return Number((sortedLatenciesMs[index] ?? 0).toFixed(2));
}

async function main(): Promise<void> {
  const pgCluster = await startIsolatedPostgresCluster();
  const disposableDb = await pgCluster.createDisposableDatabase();
  const oidcServer = await startMockOidcBoundaryServer(TEST_GOOGLE_CLIENT_ID);

  const config = buildTestConfig(disposableDb.databaseUrl, oidcServer, {
    DB_POOL_MAX: '25',
    RATE_LIMIT_GLOBAL_MAX: '50000',
    RATE_LIMIT_WRITE_MAX: '10000',
    RATE_LIMIT_AUTH_MAX: '5000',
  });

  const dbContext = createDatabaseContext(config);
  await runMigrationsToLatest(dbContext.db);
  const app = await buildApp({ config, dbContext });

  const listenAddress = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    const accountCount = 10;
    const projectsPerAccount = 5;
    const artifactsPerProject = 10;
    const fixtures: SeededAccountFixture[] = [];

    for (let a = 0; a < accountCount; a += 1) {
      const auth = await authenticateTestUser(app, oidcServer, {
        sub: `loadtest-sub-${a}`,
        email: `loadtest-${a}@pagesift.example.com`,
        name: `Load Test User ${a}`,
      });

      const projectIds: string[] = [];
      const artifactIdsByProject = new Map<string, string[]>();

      for (let p = 0; p < projectsPerAccount; p += 1) {
        const projRes = await app.inject({
          method: 'POST',
          url: '/v1/projects',
          headers: { authorization: `Bearer ${auth.accessToken}` },
          payload: {
            name: `Account ${a} Project ${p}`,
            description: `Seeded project ${p} for performance evaluation`,
            sourceDomain: 'benchmark.pagesift.dev',
          },
        });
        const projectId = projRes.json<{ project: { id: string } }>().project.id;
        projectIds.push(projectId);

        const artifactIds: string[] = [];
        for (let k = 0; k < artifactsPerProject; k += 1) {
          const artRes = await app.inject({
            method: 'POST',
            url: `/v1/projects/${projectId}/artifacts`,
            headers: { authorization: `Bearer ${auth.accessToken}` },
            payload: {
              kind: 'design_reference',
              title: `Design Reference ${k}`,
              schemaVersion: 1,
              sourceUrl: `https://benchmark.pagesift.dev/page-${k}`,
              content: {
                markdown:
                  `# Design Reference ${k}\n\n` + 'Token and typography notes. '.repeat(120),
                pageTitle: `Benchmark Page ${k}`,
                viewport: { width: 1440, height: 900 },
                sections: ['Navbar', 'Hero', 'FeatureGrid', 'Pricing', 'Footer'],
              },
            },
          });
          const artifactId = artRes.json<{ artifact: { id: string } }>().artifact.id;
          artifactIds.push(artifactId);
        }
        artifactIdsByProject.set(projectId, artifactIds);
      }

      fixtures.push({
        accessToken: auth.accessToken,
        projectIds,
        artifactIdsByProject,
      });
    }

    const totalRequests = 1500;
    const concurrency = 25;
    const latenciesMs: number[] = [];
    let completedRequests = 0;
    let errorCount = 0;
    let nextRequestIndex = 0;

    const startedAt = performance.now();

    const worker = async (workerId: number): Promise<void> => {
      while (nextRequestIndex < totalRequests) {
        const currentIndex = nextRequestIndex;
        nextRequestIndex += 1;

        const fixture = fixtures[currentIndex % fixtures.length];
        if (!fixture) {
          continue;
        }
        const projectId = fixture.projectIds[currentIndex % fixture.projectIds.length] ?? '';
        const artifactIds = fixture.artifactIdsByProject.get(projectId) ?? [];
        const artifactId = artifactIds[currentIndex % artifactIds.length] ?? '';

        const bucket = currentIndex % 10;
        let url: string;
        let method = 'GET';
        let body: string | undefined;

        if (bucket < 3) {
          url = `${listenAddress}/v1/projects/${projectId}/artifacts?limit=20`;
        } else if (bucket < 6) {
          url = `${listenAddress}/v1/projects/${projectId}/artifacts/${artifactId}`;
        } else if (bucket < 8) {
          url = `${listenAddress}/v1/projects?limit=20`;
        } else if (bucket === 8) {
          url = `${listenAddress}/v1/account/settings`;
        } else {
          method = 'POST';
          url = `${listenAddress}/v1/projects/${projectId}/artifacts`;
          body = JSON.stringify({
            kind: 'rebuild_prompt',
            title: `Load Write Prompt ${workerId}-${currentIndex}`,
            schemaVersion: 1,
            content: {
              prompt: 'Rebuild responsive card grid with accessible contrast and fluid spacing.',
              targetFramework: 'react_tailwind',
              includeLayout: true,
              includeTypography: true,
              includeColors: true,
              componentChecklist: ['Header', 'CardGrid', 'CTA'],
            },
          });
        }

        const reqStart = performance.now();
        try {
          const res = await fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${fixture.accessToken}`,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body } : {}),
          });
          const elapsed = performance.now() - reqStart;
          latenciesMs.push(elapsed);
          completedRequests += 1;
          if (res.status < 200 || res.status >= 300) {
            errorCount += 1;
          }
          await res.arrayBuffer();
        } catch {
          const elapsed = performance.now() - reqStart;
          latenciesMs.push(elapsed);
          completedRequests += 1;
          errorCount += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

    const totalDurationSeconds = (performance.now() - startedAt) / 1000;
    const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
    const throughputRps = Number((completedRequests / totalDurationSeconds).toFixed(2));
    const p50Ms = computePercentile(sortedLatencies, 50);
    const p95Ms = computePercentile(sortedLatencies, 95);
    const p99Ms = computePercentile(sortedLatencies, 99);
    const errorRatePercent = Number(((errorCount / completedRequests) * 100).toFixed(2));

    const report = {
      event: 'load_test_completed',
      environment: {
        platform: `${os.platform()} ${os.arch()} (${os.release()})`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCores: os.cpus().length,
        totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        nodeVersion: process.version,
        database: 'PostgreSQL 17.11 (isolated local cluster, pool max=25)',
      },
      dataset: {
        accounts: accountCount,
        projects: accountCount * projectsPerAccount,
        seededArtifacts: accountCount * projectsPerAccount * artifactsPerProject,
      },
      workload: {
        concurrency,
        totalRequests: completedRequests,
        requestMix: {
          listArtifactsMetadata: '30%',
          getArtifactWithBody: '30%',
          listProjects: '20%',
          getAccountSettings: '10%',
          createArtifactWriteTransaction: '10%',
        },
      },
      provisionalTargets: {
        maxErrorRatePercent: 0,
        minThroughputRps: 250,
        maxP50LatencyMs: 25,
        maxP95LatencyMs: 75,
        maxP99LatencyMs: 150,
      },
      measuredResults: {
        durationSeconds: Number(totalDurationSeconds.toFixed(2)),
        throughputRps,
        p50LatencyMs: p50Ms,
        p95LatencyMs: p95Ms,
        p99LatencyMs: p99Ms,
        errorCount,
        errorRatePercent,
      },
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    if (errorCount > 0 || throughputRps < 250 || p50Ms > 25 || p95Ms > 75 || p99Ms > 150) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await oidcServer.close();
    await disposableDb.drop();
    await pgCluster.stopCluster();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Load test failed';
  process.stderr.write(JSON.stringify({ event: 'load_test_failed', message }) + '\n');
  process.exit(1);
});
