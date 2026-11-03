/** Local-only real HTTP/Mongo/Redis/Docker regression. Run after npm run build.
 * Creates a private config and API key, never reads production credentials.
 * Only its own IDs/containers/database are cleaned. Requires node:24, mongo:7,
 * redis:7-alpine already available in the local Docker daemon.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const { IngressRegistry } = require('../../dist/ingress/ingress-registry');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-ownership-'));
const label = 'operator-ownership-' + process.pid;
const mongoName = label + '-mongo',
  redisName = label + '-redis';
const apiKey = crypto.randomBytes(32).toString('hex');
const base = 'http://127.0.0.1:3339/api/v1';
const sandboxes = new Set(),
  snapshots = new Set();
const captureScope =
  process.env.OPERATOR_QA_SCOPE === 'full' ? 'full' : 'workdir';
let app, conn, redis, registry;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function req(method, route, body, expected = 200) {
  const r = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  assert.ok(
    expected === null ||
      r.status === expected ||
      (expected === 200 && r.status === 201),
    `${method} ${route}: ${r.status} ${text.slice(0, 500)}`,
  );
  if (data?.sandboxId && route.includes('sandboxes') && method === 'POST')
    sandboxes.add(data.sandboxId);
  if (data?.snapshotId && route === '/snapshots' && method === 'POST')
    snapshots.add(data.snapshotId);
  return expected === null ? { status: r.status, data } : data;
}
async function restore(id, linked = true) {
  const r = await req('POST', `/snapshots/${id}/restore`, {
    linked,
    ttlSeconds: 600,
  });
  sandboxes.add(r.sandboxId);
  return r;
}
async function command(id, command) {
  const r = await req('POST', `/sandboxes/${id}/command`, { command });
  assert.equal(r.code, 0);
  return r.stdout;
}
async function until(fn, message) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await sleep(250);
  }
  throw Error(message);
}
(async () => {
  try {
    docker(
      'run',
      '-d',
      '--name',
      mongoName,
      '-p',
      '127.0.0.1:27339:27017',
      'mongo:7',
    );
    docker(
      'run',
      '-d',
      '--name',
      redisName,
      '-p',
      '127.0.0.1:26339:6379',
      'redis:7-alpine',
    );
    const uri = `mongodb://127.0.0.1:27339/${label.replaceAll('-', '_')}_qa`;
    conn = await mongoose.createConnection(uri).asPromise();
    redis = new Redis('redis://127.0.0.1:26339');
    const socket = docker(
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ).replace('unix://', '');
    const config = {
      server: { port: 3339, basePath: '/api/v1' },
      database: { uri },
      redis: { url: 'redis://127.0.0.1:26339' },
      runtime: {
        type: 'docker',
        docker: {
          socketPath: socket,
          runtime: 'runc',
          network: 'bridge',
          hardening: { apparmorProfile: 'unconfined' },
        },
      },
      defaults: {
        defaultImage: 'node:24',
        defaultCpus: 1,
        defaultMemoryMib: 256,
        defaultTtlSeconds: 600,
        maxTtlSeconds: 7200,
        ttlCheckIntervalMs: 5000,
        commandTimeoutMs: 30000,
      },
      maintenance: { containerSweepIntervalMs: 3600000 },
      ingress: {
        enabled: true,
        wildcardDomain: 'sandbox.localhost',
        proxyPort: 3839,
        proxyHost: '127.0.0.1',
      },
      snapshots: {
        defaultScope: captureScope,
        imageCache: { enabled: captureScope === 'full', commitLive: true },
      },
      auth: {
        enabled: true,
        strategy: 'api-key',
        apiKeys: [{ name: 'qa', key: '${OPERATOR_QA_API_KEY}' }],
      },
      mcp: { enabled: false },
    };
    fs.writeFileSync(path.join(dir, 'config.yml'), JSON.stringify(config), {
      mode: 0o600,
    });
    const log = fs.openSync(path.join(dir, 'app.log'), 'a', 0o600);
    app = spawn(process.execPath, [path.join(root, 'dist/main.js')], {
      cwd: dir,
      env: { ...process.env, OPERATOR_QA_API_KEY: apiKey },
      stdio: ['ignore', log, log],
    });
    await until(async () => {
      try {
        return (
          await fetch(base + '/sandboxes', { headers: { 'x-api-key': apiKey } })
        ).ok;
      } catch {
        return false;
      }
    }, 'app failed to start');
    const source = await req('POST', '/sandboxes', {
      image: 'node:24',
      ttlSeconds: 600,
      memoryMib: 256,
    });
    await command(
      source.sandboxId,
      'mkdir -p /workspace; echo original > /workspace/marker',
    );
    const snapshot = await req('POST', '/snapshots', {
      sandboxId: source.sandboxId,
      scope: captureScope,
    });
    await req('POST', `/sandboxes/${source.sandboxId}/stop`, { save: false });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        req(
          'POST',
          `/snapshots/${snapshot.snapshotId}/restore`,
          { ttlSeconds: 600 },
          null,
        ),
      ),
    );
    for (const r of attempts)
      if (r.status < 300) sandboxes.add(r.data.sandboxId);
    assert.ok(attempts.every((r) => r.status < 300 || r.status === 409));
    const live = await conn.db
      .collection('sandboxes')
      .find({ snapshotId: snapshot.snapshotId, status: 'running' })
      .toArray();
    assert.equal(live.length, 1, 'one linked owner');
    const owner = live[0];
    sandboxes.add(owner.sandboxId);
    assert.equal(
      (await restore(snapshot.snapshotId)).sandboxId,
      owner.sandboxId,
    );
    assert.equal(
      (
        await req(
          'DELETE',
          `/snapshots/${snapshot.snapshotId}`,
          undefined,
          null,
        )
      ).status,
      409,
    );
    const forks = await Promise.all([
      restore(snapshot.snapshotId, false),
      restore(snapshot.snapshotId, false),
    ]);
    assert.equal(
      new Set([owner.publicUrl, ...forks.map((f) => f.publicUrl)]).size,
      3,
      'fork URLs unique',
    );
    const key = 'sandbox:ingress:' + owner.subdomain;
    assert.equal(JSON.parse(await redis.get(key)).sandboxId, owner.sandboxId);
    registry = new IngressRegistry(config);
    await assert.rejects(
      () =>
        registry.publish(
          owner.subdomain,
          {
            sandboxId: 'intruder',
            upstreamHost: '127.0.0.1',
            upstreamPort: 80,
          },
          30,
        ),
      /PUBLIC_ROUTE_IN_USE/,
    );
    assert.equal(await registry.unpublish(owner.subdomain, 'intruder'), false);
    await registry.extendTtl(owner.subdomain, 1, 'intruder');
    assert.ok((await redis.ttl(key)) > 1);
    // A version change between read and claim must lose the Mongo CAS.
    const {
      SnapshotRepository,
    } = require('../../dist/repositories/snapshot.repository');
    const { SnapshotSchema } = require('../../dist/schemas/snapshot.schema');
    const {
      SnapshotsService,
    } = require('../../dist/snapshots/snapshots.service');
    const snapshotRepo = new SnapshotRepository(
      conn.model('Snapshot', SnapshotSchema),
      [],
    );
    const originalUpdate = snapshotRepo.updateOne.bind(snapshotRepo);
    let interposed = false;
    snapshotRepo.updateOne = async (filter, update, scope) => {
      if (update.$set?.saveState === 'saving' && !interposed) {
        interposed = true;
        await conn.db
          .collection('snapshots')
          .updateOne(
            { snapshotId: snapshot.snapshotId },
            { $inc: { persistVersion: 1 } },
          );
      }
      return originalUpdate(filter, update, scope);
    };
    const service = Object.create(SnapshotsService.prototype);
    Object.assign(service, {
      snapshotRepo,
      sandboxRepo: {
        findOwningSandbox: async () => null,
        findOne: async () => owner,
      },
      logger: { warn() {}, error() {} },
    });
    assert.equal(
      await service.persistToSnapshot(owner, snapshot.snapshotId),
      'conflict',
    );
    assert.ok(interposed);
    await conn.db
      .collection('snapshots')
      .updateOne(
        { snapshotId: snapshot.snapshotId },
        { $inc: { persistVersion: -1 } },
      );
    // Deletion is also blocked by an in-flight capture of an otherwise unowned snapshot.
    await conn.db
      .collection('snapshots')
      .updateOne(
        { snapshotId: snapshot.snapshotId },
        { $set: { saveState: 'saving' } },
      );
    assert.equal(
      (
        await req(
          'DELETE',
          `/snapshots/${snapshot.snapshotId}`,
          undefined,
          null,
        )
      ).status,
      409,
    );
    await conn.db
      .collection('snapshots')
      .updateOne(
        { snapshotId: snapshot.snapshotId },
        { $set: { saveState: 'idle' } },
      );
    // A fork may not save over the linked owner's disk, even with an explicit ID.
    assert.equal(
      (
        await req(
          'POST',
          `/sandboxes/${forks[0].sandboxId}/stop`,
          { snapshotId: snapshot.snapshotId },
          null,
        )
      ).status,
      409,
    );
    await command(owner.sandboxId, 'echo committed > /workspace/marker');
    await req('POST', `/sandboxes/${owner.sandboxId}/stop`, { save: true });
    // This is now a stale fork. Explicit snapshotId must not bypass the version guard.
    assert.equal(
      (
        await req(
          'POST',
          `/sandboxes/${forks[0].sandboxId}/stop`,
          { snapshotId: snapshot.snapshotId },
          null,
        )
      ).status,
      409,
    );
    const next = await restore(snapshot.snapshotId);
    assert.match(
      await command(next.sandboxId, 'cat /workspace/marker'),
      /committed/,
    );
    // Simulate only in this isolated fixture the historical missing-snapshot state.
    await command(next.sandboxId, 'echo preserved > /workspace/recovery');
    await conn.db.collection('sandboxes').updateOne(
      { sandboxId: next.sandboxId },
      {
        $set: {
          snapshotId: 'missing-qa',
          expiresAt: new Date(Date.now() - 1000),
        },
      },
    );
    await until(
      async () =>
        (await req('GET', `/sandboxes/${next.sandboxId}`)).status ===
        'recovery_pending',
      'disk was not parked',
    );
    assert.equal(
      docker(
        'inspect',
        '--format',
        '{{.State.Running}}',
        'sandbox-' + next.sandboxId,
      ),
      'false',
    );
    await req('POST', `/sandboxes/${next.sandboxId}/recover`, {});
    const recovered = await req('GET', `/sandboxes/${next.sandboxId}`);
    assert.equal(recovered.snapshotId, undefined);
    assert.match(
      await command(next.sandboxId, 'cat /workspace/recovery'),
      /preserved/,
    );
    const rescue = await req('POST', '/snapshots', {
      sandboxId: next.sandboxId,
      scope: captureScope,
    });
    const rescueSession = await restore(rescue.snapshotId, false);
    assert.match(
      await command(rescueSession.sandboxId, 'cat /workspace/recovery'),
      /preserved/,
    );
    // Sweep against the real repository must keep preserved disks.
    await conn.db
      .collection('sandboxes')
      .updateOne(
        { sandboxId: rescueSession.sandboxId },
        { $set: { status: 'recovery_pending' } },
      );
    const {
      SandboxRepository,
    } = require('../../dist/repositories/sandbox.repository');
    const { SandboxSchema } = require('../../dist/schemas/sandbox.schema');
    const repo = new SandboxRepository(
      conn.model('Sandbox', SandboxSchema),
      [],
    );
    assert.ok(
      (await repo.findLiveContainerNames()).includes(
        'sandbox-' + rescueSession.sandboxId,
      ),
    );
    console.log(
      JSON.stringify({
        scope: captureScope,
        concurrentRestores: 8,
        singleOwner: true,
        saveVersionCAS: true,
        forkUrls: true,
        atomicRoutes: true,
        deleteBlocked: true,
        explicitStaleSaveBlocked: true,
        expiryStoppedDisk: true,
        recoverySnapshotRoundtrip: true,
        sweepProtection: true,
      }),
    );
  } finally {
    if (app) {
      // Include failed concurrent restore records (they never created a container).
      if (conn)
        for (const d of await conn.db
          .collection('sandboxes')
          .find({})
          .toArray())
          sandboxes.add(d.sandboxId);
      for (const id of sandboxes) {
        try {
          await req('DELETE', '/sandboxes/' + id, undefined, null);
        } catch {}
      }
      for (const id of snapshots) {
        try {
          await req('DELETE', '/snapshots/' + id, undefined, null);
        } catch {}
      }
      app.kill('SIGTERM');
      await new Promise((r) =>
        app.exitCode !== null ? r() : app.once('exit', r),
      );
    }
    if (registry) await registry.onModuleDestroy();
    if (redis) await redis.quit();
    if (conn) await conn.close();
    for (const id of sandboxes) {
      try {
        docker('rm', '-f', 'sandbox-' + id);
      } catch {}
    }
    for (const id of snapshots) {
      try {
        docker('image', 'rm', 'devic-snapshot:' + id);
      } catch {}
    }
    for (const name of [mongoName, redisName]) {
      try {
        docker('rm', '-f', name);
      } catch {}
    }
    console.log('Local diagnostic log: ' + path.join(dir, 'app.log'));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
