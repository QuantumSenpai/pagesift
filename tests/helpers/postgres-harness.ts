import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';

const { Client } = pg;

export interface IsolatedPostgresCluster {
  adminUrl: string;
  createDisposableDatabase: () => Promise<{
    databaseUrl: string;
    databaseName: string;
    drop: () => Promise<void>;
  }>;
  stopCluster: () => Promise<void>;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => {
          resolve(port);
        });
      } else {
        server.close(() => {
          reject(new Error('Failed to determine free port'));
        });
      }
    });
    server.on('error', reject);
  });
}

function resolvePostgresBinary(binaryName: string): string {
  const candidates = [
    path.join('/opt/homebrew/bin', binaryName),
    path.join('/usr/local/bin', binaryName),
    path.join('/usr/bin', binaryName),
    binaryName,
  ];
  for (const candidate of candidates) {
    if (candidate === binaryName || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return binaryName;
}

export async function startIsolatedPostgresCluster(): Promise<IsolatedPostgresCluster> {
  const externalAdminUrl = process.env['TEST_ADMIN_DATABASE_URL'];
  let tempDir: string | null = null;
  let adminUrl: string;

  if (externalAdminUrl && externalAdminUrl.length > 0) {
    adminUrl = externalAdminUrl;
  } else {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesift-pg-test-'));
    const dataDir = path.join(tempDir, 'data');
    const logFile = path.join(tempDir, 'postgres.log');
    const port = await findFreePort();
    const initdbBin = resolvePostgresBinary('initdb');
    const pgCtlBin = resolvePostgresBinary('pg_ctl');

    execFileSync(
      initdbBin,
      ['-D', dataDir, '-U', 'pagesift_test', '--auth=trust', '--no-locale', '--encoding=UTF8'],
      { stdio: 'pipe' },
    );

    execFileSync(
      pgCtlBin,
      [
        '-D',
        dataDir,
        '-l',
        logFile,
        '-w',
        '-o',
        `-p ${port} -h 127.0.0.1 -k ${tempDir} -F`,
        'start',
      ],
      { stdio: 'pipe' },
    );

    adminUrl = `postgresql://pagesift_test@127.0.0.1:${port}/postgres`;
  }

  const createDisposableDatabase = async (): Promise<{
    databaseUrl: string;
    databaseName: string;
    drop: () => Promise<void>;
  }> => {
    const dbSuffix = randomUUID().replace(/-/g, '').slice(0, 16);
    const databaseName = `pagesift_test_${dbSuffix}`;
    const adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminClient.end();
    }

    const parsedUrl = new URL(adminUrl);
    parsedUrl.pathname = `/${databaseName}`;
    const databaseUrl = parsedUrl.toString();

    const drop = async (): Promise<void> => {
      const cleanupClient = new Client({ connectionString: adminUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [databaseName],
        );
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await cleanupClient.end();
      }
    };

    return {
      databaseUrl,
      databaseName,
      drop,
    };
  };

  const stopCluster = async (): Promise<void> => {
    await Promise.resolve();
    if (tempDir !== null) {
      const dataDir = path.join(tempDir, 'data');
      const pgCtlBin = resolvePostgresBinary('pg_ctl');
      if (fs.existsSync(path.join(dataDir, 'postmaster.pid'))) {
        execFileSync(pgCtlBin, ['-D', dataDir, '-m', 'immediate', 'stop'], {
          stdio: 'pipe',
        });
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  };

  return {
    adminUrl,
    createDisposableDatabase,
    stopCluster,
  };
}
