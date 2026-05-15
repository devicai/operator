/**
 * Live integration test for the snapshot create + restore (linked & fork) flow.
 *
 * Drives the real SnapshotsService against real Docker:
 *   1. crea sandbox A
 *   2. modifica filesystem y cwd
 *   3. snapshot
 *   4. restore linked (B): debe ver el filesystem y el cwd persistido
 *   5. modifica B → stop(B) ⇒ persistToSnapshot
 *   6. restore fork (C): heredera del snapshot pero sin link, modifica y verifica
 *      que el snapshot no cambia
 *   7. cleanup
 *
 * Run with:
 *   nvm use 24
 *   npx ts-node -P tsconfig.build.json test/integration/snapshot-restore.live.ts
 */

import 'reflect-metadata';
import Docker from 'dockerode';
import { existsSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DockerRuntimeProvider } from '../../src/runtime/docker.runtime-provider';
import { SnapshotsService } from '../../src/snapshots/snapshots.service';
import { SandboxesService } from '../../src/sandboxes/sandboxes.service';
import type { ModuleConfig } from '../../src/config/config.types';

const IMAGE = process.env.LIVE_TEST_IMAGE ?? 'alpine:3.20';

const config: ModuleConfig = {
  server: { port: 0, basePath: '/api/v1' },
  database: { provider: 'mongodb', uri: 'mongodb://localhost/unused' },
  redis: { url: 'redis://localhost/unused' },
  defaults: {
    defaultImage: IMAGE,
    defaultCpus: 1,
    defaultMemoryMib: 256,
    defaultTtlSeconds: 600,
    maxTtlSeconds: 7200,
    ttlCheckIntervalMs: 30_000,
  },
  runtime: {
    type: 'docker',
    docker: {
      socketPath: '/var/run/docker.sock',
      runtime: 'runc',
      network: 'bridge',
      hardening: {
        dropAllCaps: false,
        noNewPrivileges: false,
        readOnlyRootfs: false,
        seccompProfile: 'default',
        pidsLimit: 512,
      },
    },
  },
  mcp: { enabled: false },
  extensions: { properties: [] },
  auth: { enabled: false, strategy: 'none' },
  logging: { level: 'info', format: 'json' },
};

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
    failures.push(label);
  }
}

/**
 * Minimal in-memory repositories that implement just what SnapshotsService /
 * SandboxesService use here. We don't want to spin up Mongo for a live test.
 */
class InMemoryRepo<T extends { _id?: string }> {
  private docs = new Map<string, T>();
  private seq = 1;

  async create(doc: any, _scope?: any): Promise<any> {
    const _id = String(this.seq++);
    const full = { ...doc, _id, createdAt: new Date(), updatedAt: new Date() };
    this.docs.set(_id, full as T);
    return full;
  }

  async findById(id: string, _scope?: any): Promise<T | null> {
    return this.docs.get(id) ?? null;
  }

  async findOne(filter: Record<string, any>, _scope?: any): Promise<T | null> {
    for (const doc of this.docs.values()) {
      let match = true;
      for (const [k, v] of Object.entries(filter)) {
        if ((doc as any)[k] !== v) {
          match = false;
          break;
        }
      }
      if (match) return doc;
    }
    return null;
  }

  async updateById(id: string, update: any, _scope?: any): Promise<T | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let cur: any = doc;
          for (let i = 0; i < parts.length - 1; i++) {
            cur[parts[i]] = cur[parts[i]] ?? {};
            cur = cur[parts[i]];
          }
          cur[parts[parts.length - 1]] = v;
        } else {
          (doc as any)[k] = v;
        }
      }
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        (doc as any)[k] = ((doc as any)[k] ?? 0) + Number(v);
      }
    }
    return doc;
  }

  async deleteById(id: string, _scope?: any): Promise<void> {
    this.docs.delete(id);
  }

  async find(_filter: any, _scope?: any, _opts?: any): Promise<any> {
    return { items: Array.from(this.docs.values()), total: this.docs.size };
  }

  async findByBinding() {
    return null;
  }
}

class StubRegistry {
  private map = new Map<string, string>();
  async register(sandboxId: string, containerName: string, _ttl: number) {
    this.map.set(sandboxId, containerName);
  }
  async get(sandboxId: string): Promise<string | null> {
    return this.map.get(sandboxId) ?? null;
  }
  async remove(sandboxId: string) {
    this.map.delete(sandboxId);
  }
  async extendTtl() {}
}

class StubResourceUsage {
  async assertMemoryAvailable() {}
  async assertDiskAvailable() {}
}

async function main(): Promise<void> {
  const provider = new DockerRuntimeProvider(config);
  const snapshotRepo: any = new InMemoryRepo();
  const sandboxRepo: any = new InMemoryRepo();
  const registry = new StubRegistry();
  const resourceUsage = new StubResourceUsage();

  const snapshotsService = new SnapshotsService(
    snapshotRepo,
    sandboxRepo,
    registry as any,
    config,
    resourceUsage as any,
    provider,
  );

  // ===========================================================================
  console.log(`▶ Test 1: create source sandbox A on '${IMAGE}'`);
  // ===========================================================================
  const nameA = `devic-snap-src-${Date.now()}`;
  const sandboxA = await provider.create({
    name: nameA,
    image: IMAGE,
    workdir: '/workspace',
    cpus: 1,
    memoryMib: 256,
    env: { FOO: 'from-create' },
    networkPolicy: 'allow-all',
  });

  const docA = await sandboxRepo.create({
    sandboxId: 'src',
    name: nameA,
    status: 'running',
    image: IMAGE,
    workdir: '/workspace',
    currentCwd: '/workspace/sub',
    cpus: 1,
    memoryMib: 256,
    envVars: { FOO: 'from-create' },
    ports: {},
    ttlSeconds: 600,
    expiresAt: new Date(Date.now() + 600_000),
    commandCount: 0,
    recentCommands: [],
    metadata: {},
  });
  await registry.register('src', nameA, 600);

  await sandboxA.exec(`mkdir -p /workspace/sub && echo 'hello-from-A' > /workspace/sub/marker.txt`);
  check(
    `marker file created in source workdir`,
    (await sandboxA.exec(`cat /workspace/sub/marker.txt`)).stdout.trim() ===
      'hello-from-A',
  );

  // ===========================================================================
  console.log(`\n▶ Test 2: snapshot source sandbox`);
  // ===========================================================================
  const snapshot = await snapshotsService.create(
    { sandboxId: 'src', name: 'test-snap' } as any,
    {} as any,
  );

  check(`snapshot status is READY`, snapshot.status === 'ready', `got '${snapshot.status}'`);
  check(`snapshot file exists on disk`, existsSync(snapshot.snapshotPath));
  check(`snapshot size > 0`, snapshot.sizeBytes > 0);
  check(
    `snapshot metadata.currentCwd carries source cwd`,
    (snapshot.metadata as any)?.currentCwd === '/workspace/sub',
    `got '${(snapshot.metadata as any)?.currentCwd}'`,
  );

  // ===========================================================================
  console.log(`\n▶ Test 3: restore as LINKED sandbox B`);
  // ===========================================================================
  const sandboxBDoc = await snapshotsService.restore(
    snapshot.snapshotId,
    { linked: true } as any,
    {} as any,
  );

  check(`B status RUNNING`, sandboxBDoc.status === 'running', `got '${sandboxBDoc.status}'`);
  check(
    `B is linked to source snapshot`,
    (sandboxBDoc as any).snapshotId === snapshot.snapshotId,
    `got '${(sandboxBDoc as any).snapshotId}'`,
  );
  check(
    `B.currentCwd carries forward from snapshot metadata`,
    sandboxBDoc.currentCwd === '/workspace/sub',
    `got '${sandboxBDoc.currentCwd}'`,
  );

  // Verify the filesystem was restored:
  const handleB = await provider.get(sandboxBDoc.name);
  if (!handleB) {
    throw new Error('B container missing after restore');
  }
  const sandboxB = await handleB.connect();
  const readBackB = await sandboxB.exec(`cat /workspace/sub/marker.txt`);
  check(
    `B has the marker file from snapshot`,
    readBackB.stdout.trim() === 'hello-from-A',
    `code=${readBackB.code}, stdout='${readBackB.stdout.trim()}', stderr='${readBackB.stderr.trim()}'`,
  );

  // Open the persistent shell from cwd carried in the doc and confirm pwd.
  const shellB = await sandboxB.openShell(sandboxBDoc.currentCwd);
  const pwdB = await shellB.run(`pwd`);
  check(
    `B persistent shell starts at restored cwd`,
    pwdB.stdout.trim() === '/workspace/sub',
    `got '${pwdB.stdout.trim()}'`,
  );

  // ===========================================================================
  console.log(`\n▶ Test 4: modify B then stop → persistToSnapshot`);
  // ===========================================================================
  await sandboxB.exec(`echo 'modified-by-B' >> /workspace/sub/marker.txt`);
  await sandboxB.exec(`echo 'b-only' > /workspace/sub/b-only.txt`);

  // Stamp the in-memory doc as if SandboxesService had recorded a moved cwd.
  await sandboxRepo.updateById((sandboxBDoc as any)._id, {
    $set: { currentCwd: '/workspace' },
  });
  const sandboxBDocFresh = await sandboxRepo.findById((sandboxBDoc as any)._id);

  const sizeBefore = statSync(snapshot.snapshotPath).size;
  await snapshotsService.persistToSnapshot(sandboxBDocFresh!);
  const sizeAfter = statSync(snapshot.snapshotPath).size;

  check(
    `snapshot file still exists after persist`,
    existsSync(snapshot.snapshotPath),
  );
  check(
    `snapshot file size changed after persist`,
    sizeBefore !== sizeAfter,
    `before=${sizeBefore} after=${sizeAfter}`,
  );

  const snapshotAfterPersist = await snapshotRepo.findById((snapshot as any)._id);
  check(
    `snapshot.metadata.currentCwd updated to B's cwd`,
    (snapshotAfterPersist!.metadata as any)?.currentCwd === '/workspace',
    `got '${(snapshotAfterPersist!.metadata as any)?.currentCwd}'`,
  );

  // ===========================================================================
  console.log(`\n▶ Test 5: restore as FORK sandbox C from updated snapshot`);
  // ===========================================================================
  const sandboxCDoc = await snapshotsService.restore(
    snapshot.snapshotId,
    { linked: false } as any,
    {} as any,
  );

  check(`C status RUNNING`, sandboxCDoc.status === 'running', `got '${sandboxCDoc.status}'`);
  check(
    `C is NOT linked to source snapshot (fork)`,
    !(sandboxCDoc as any).snapshotId,
    `got '${(sandboxCDoc as any).snapshotId}'`,
  );
  check(
    `C.metadata.linked === false`,
    (sandboxCDoc.metadata as any)?.linked === false,
    `got '${(sandboxCDoc.metadata as any)?.linked}'`,
  );

  const handleC = await provider.get(sandboxCDoc.name);
  if (!handleC) throw new Error('C container missing after restore');
  const sandboxC = await handleC.connect();

  const readBackC = await sandboxC.exec(`cat /workspace/sub/marker.txt`);
  check(
    `C inherits both original + B's modification`,
    readBackC.stdout.includes('hello-from-A') &&
      readBackC.stdout.includes('modified-by-B'),
    `got stdout='${readBackC.stdout}'`,
  );
  const readBOnly = await sandboxC.exec(`cat /workspace/sub/b-only.txt`);
  check(
    `C has b-only.txt (snapshot was persisted from B before fork)`,
    readBOnly.stdout.trim() === 'b-only',
    `got code=${readBOnly.code} stdout='${readBOnly.stdout.trim()}'`,
  );

  // ===========================================================================
  console.log(`\n▶ Test 6: fork C is independent — its writes don't persist back`);
  // ===========================================================================
  await sandboxC.exec(`echo 'c-fork-write' > /workspace/sub/c-fork.txt`);
  // Update C's cwd in the in-memory doc too (simulate a runCommand flow).
  await sandboxRepo.updateById((sandboxCDoc as any)._id, {
    $set: { currentCwd: '/tmp' },
  });
  const sandboxCDocFresh = await sandboxRepo.findById((sandboxCDoc as any)._id);

  // Even if persistToSnapshot is called on the fork, it should do nothing
  // because the fork has no linked snapshotId.
  const sizeBeforeForkPersist = statSync(snapshot.snapshotPath).size;
  await snapshotsService.persistToSnapshot(sandboxCDocFresh!);
  const sizeAfterForkPersist = statSync(snapshot.snapshotPath).size;
  check(
    `fork C's persistToSnapshot is a no-op (snapshot file unchanged)`,
    sizeBeforeForkPersist === sizeAfterForkPersist,
    `before=${sizeBeforeForkPersist} after=${sizeAfterForkPersist}`,
  );

  // The c-fork.txt should NOT appear if we restore a NEW sandbox from the
  // snapshot, since the fork's changes never went back to disk.
  const sandboxDDoc = await snapshotsService.restore(
    snapshot.snapshotId,
    { linked: false } as any,
    {} as any,
  );
  const handleD = await provider.get(sandboxDDoc.name);
  const sandboxD = await handleD!.connect();
  const cForkInD = await sandboxD.exec(
    `[ -f /workspace/sub/c-fork.txt ] && echo yes || echo no`,
  );
  check(
    `fresh restore D does NOT see fork C's private write`,
    cForkInD.stdout.trim() === 'no',
    `got '${cForkInD.stdout.trim()}'`,
  );

  // ===========================================================================
  console.log(`\n▶ Cleanup`);
  // ===========================================================================
  for (const name of [nameA, sandboxBDoc.name, sandboxCDoc.name, sandboxDDoc.name]) {
    try {
      await provider.remove(name);
    } catch (err) {
      console.warn(`  could not remove ${name}: ${(err as Error).message}`);
    }
  }
  try {
    if (existsSync(snapshot.snapshotPath)) unlinkSync(snapshot.snapshotPath);
  } catch {}

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  } else {
    console.log(`\n✓ All checks passed`);
  }
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
