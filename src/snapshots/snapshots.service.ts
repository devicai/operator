import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as net from 'net';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  createReadStream,
  createWriteStream,
} from 'fs';
import { homedir } from 'os';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import { IngressService } from '../ingress/ingress.service';
import { SandboxWakeupService } from '../ingress/sandbox-wakeup.service';
import {
  SnapshotDocument,
  SnapshotSaveStage,
  SnapshotSaveState,
  SnapshotStatus,
} from '../schemas/snapshot.schema';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSnapshotDto, SnapshotScope } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ImportSnapshotDto } from './dto/import-snapshot.dto';
import { UpdateSnapshotDto } from './dto/update-snapshot.dto';
import { validateStartCommand } from './start-command.validation';
import { tarballToZipStream, zipToTarGz } from './snapshot-zip.util';
import { Readable } from 'stream';
import { ResourceUsageService } from '../providers/resource-usage.service';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  RuntimeSandbox,
} from '../runtime/runtime-provider.interface';
import {
  buildExcludeMatcher,
  cleanupPrefixes,
  partitionChanges,
  isSafeDeletePath,
  sh,
} from './snapshot-fs.util';
import { SnapshotImageService } from './snapshot-image.service';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Whether the `zstd` binary is on PATH. Probed once: it either ships with the
 * image or it does not, and the answer decides between a multi-core compressor
 * and Node's single-threaded one on every capture.
 */
let zstdCliAvailable: boolean | null = null;
async function hasZstdCli(): Promise<boolean> {
  if (zstdCliAvailable !== null) return zstdCliAvailable;
  try {
    await execFileAsync('zstd', ['--version'], { maxBuffer: 64 * 1024 });
    zstdCliAvailable = true;
  } catch {
    zstdCliAvailable = false;
  }
  return zstdCliAvailable;
}

const SNAPSHOTS_DIR = join(homedir(), '.devic-sandbox', 'snapshots');

/**
 * zstd level for full-snapshot artifacts.
 *
 * Was 19, which is a bad trade at any speed. Measured over a 762 MB tar with
 * `-T0` on ten cores:
 *
 *     -3    0.90 s   244 MB
 *     -9    1.47 s   214 MB      <- here
 *     -19  25.71 s   184 MB
 *     gzip -9        262 MB
 *
 * Level 19 costs 28x the time of level 3 to save a further 25%, and level 9
 * gets within 16% of it for a seventeenth of the work. Even at 9 this beats the
 * gzip default on both axes at once — smaller AND faster — which is the whole
 * reason to prefer zstd here.
 *
 * The number matters more than it used to: with `-T0` unavailable the fallback
 * below runs single-threaded, where 19 would take minutes.
 */
const ZSTD_LEVEL = 9;
/** gzip level used when zstd is unavailable. */
const GZIP_LEVEL = 9;
/**
 * Upper bound on how many delete paths we persist in the snapshot doc. Deletes
 * of base-image files are rare; this guards the 16 MB Mongo doc limit. When
 * exceeded we keep the first N and log — restore replays what it has.
 */
const MAX_PERSISTED_DELETES = 20000;

/**
 * Suffix of the file a capture writes to before it is renamed over the real
 * artifact. Also the marker the boot sweep uses to reclaim leftovers.
 */
const SAVING_SUFFIX = '.saving-';

type Codec = 'zstd' | 'gzip';

/**
 * What a save attempt did. Persisting is best-effort by design (a failed save
 * must never block a stop), so callers that DO care — the stop endpoint — read
 * this instead of relying on an exception.
 */
export type SnapshotSaveOutcome = 'saved' | 'skipped' | 'conflict' | 'failed';

/**
 * Stages that belong to the save the caller is waiting on, as opposed to the
 * background pass it schedules on its way out. Only these may be cleared when
 * the save releases its claim.
 */
const FOREGROUND_SAVE_STAGES = [
  SnapshotSaveStage.CLAIMING,
  SnapshotSaveStage.CLEANING,
  SnapshotSaveStage.COMMITTING,
  SnapshotSaveStage.CAPTURING,
];

export interface PersistOptions {
  /**
   * The sandbox is being torn down and will not be used again.
   *
   * Two things hang off this. Regenerable caches are deleted before the layer
   * is sealed, which is free when the container is dying and destructive when
   * it is not; and the commit is allowed to freeze the container, which costs
   * nothing here and would stall a sandbox still serving requests.
   */
  terminal?: boolean;
}

@Injectable()
export class SnapshotsService implements OnModuleInit {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly resourceUsage: ResourceUsageService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    private readonly imageService: SnapshotImageService,
    @Optional() private readonly ingressService?: IngressService,
    @Optional() private readonly wakeupService?: SandboxWakeupService,
  ) {
    if (!existsSync(SNAPSHOTS_DIR)) {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  }

  /**
   * Replay a snapshot's tarball into an already-running container. Shared by
   * the tarball restore path and by the image cache's build.
   */
  private async applyTarballTo(
    containerName: string,
    snapshot: SnapshotDocument,
  ): Promise<void> {
    const onDiskPath = this.resolveSnapshotPath(snapshot.snapshotPath);
    if (!existsSync(onDiskPath)) {
      throw new BadRequestException('Snapshot file not found on disk');
    }
    const handle = await this.runtime.get(containerName);
    if (!handle) {
      throw new Error(`container ${containerName} is not reachable`);
    }
    const sandbox = await handle.connect();
    const scope: SnapshotScope = (snapshot.scope as SnapshotScope) ?? 'workdir';
    const codec: Codec = (snapshot.compression as Codec) ?? 'gzip';

    if (scope === 'full') {
      await this.restoreFull(
        sandbox,
        snapshot.workdir,
        containerName,
        onDiskPath,
        codec,
        (snapshot.metadata?.deletes as string[]) ?? [],
      );
    } else {
      await this.restoreWorkdir(
        sandbox,
        snapshot.workdir,
        containerName,
        onDiskPath,
      );
    }
  }

  /**
   * Reclaim captures that a restart interrupted. Nothing survives the process
   * that was running them, so any `saving` snapshot or `creating` document
   * found at boot is dead: its temp file is garbage and its flag would
   * otherwise block every future save and force-less restore forever.
   *
   * Safe because the module owns its captures in-process — there is no other
   * writer that could legitimately be mid-save while we boot.
   */
  async onModuleInit(): Promise<void> {
    // The image cache materializes a snapshot by replaying its tarball into a
    // throwaway container. Hand it THIS service's extraction routine rather
    // than letting it grow its own: the image must contain exactly what a
    // tarball restore would produce, and the only way to guarantee that is to
    // run the same code.
    this.imageService.registerTarballApplier((containerName, snapshot) =>
      this.applyTarballTo(containerName, snapshot),
    );

    // The other direction, for the same reason: after a commit-based save the
    // tarball is behind, and rebuilding it means capturing from a container of
    // the image — which is this service's capture routine, not the cache's.
    this.imageService.registerTarballRefresher((snapshot) =>
      this.refreshTarballFromImage(snapshot),
    );

    // Same reason the image cache gets its applier injected rather than
    // importing this service: the ingress already sits below us (we publish
    // through it), so it cannot depend on us without closing a cycle.
    //
    // Linked, like any other restore. What gets served this way is an app with
    // users — a form, a database, anything that writes — and an unlinked
    // sandbox drops every one of those writes when its TTL runs out. Waking on
    // a visit is only useful if what visitors do then survives, so the snapshot
    // is the thing that persists and it has to be written back to.
    this.wakeupService?.registerRestorer((snapshotId, ttlSeconds) =>
      this.wakeRestore(snapshotId, ttlSeconds),
    );

    try {
      const stale = await this.snapshotRepo.updateMany(
        { saveState: SnapshotSaveState.SAVING } as any,
        {
          $set: { saveState: SnapshotSaveState.IDLE },
          $unset: {
            savingSince: '',
            savingSandboxId: '',
            saveStage: '',
            saveStageSince: '',
          },
        },
      );
      const orphanedCreates = await this.snapshotRepo.updateMany(
        { status: SnapshotStatus.CREATING } as any,
        { $set: { status: SnapshotStatus.FAILED } },
      );
      const files = this.sweepPartialCaptures();
      if (stale || orphanedCreates || files) {
        this.logger.log(
          `Reclaimed interrupted captures at boot: ${stale} saving, ` +
            `${orphanedCreates} creating, ${files} partial file(s) removed`,
        );
      }
    } catch (err) {
      // Never keep the module from booting over a cleanup.
      this.logger.warn(
        `Could not reclaim interrupted captures: ${(err as Error).message}`,
      );
    }
  }

  /** Delete `*.saving-*` leftovers in the snapshots dir. Returns how many. */
  private sweepPartialCaptures(): number {
    let removed = 0;
    for (const dir of [SNAPSHOTS_DIR]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (!entry.includes(SAVING_SUFFIX)) continue;
        try {
          unlinkSync(join(dir, entry));
          removed++;
        } catch {}
      }
    }
    return removed;
  }

  /**
   * Where a capture writes before it becomes the artifact of record. Captures
   * must never write the final path directly: a restore that lands mid-write
   * would read a truncated tarball, and a crash would leave one behind. The
   * rename at the end is atomic, so readers see either the previous capture or
   * the new one, never a half-written file.
   */
  private tempCapturePath(targetPath: string, id: string): string {
    return `${targetPath}${SAVING_SUFFIX}${id}`;
  }

  /** Rename a finished capture over its final path, failing if it is empty. */
  private commitCapture(tmpPath: string, targetPath: string): number {
    let size = 0;
    try {
      size = statSync(tmpPath).size;
    } catch {
      throw new Error('capture produced no artifact');
    }
    if (size === 0) throw new Error('capture produced an empty artifact');
    renameSync(tmpPath, targetPath);
    return size;
  }

  private discardCapture(tmpPath: string): void {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
    // zstd stages an uncompressed tar next to the target before compressing.
    try {
      const raw = `${tmpPath}.rawtar`;
      if (existsSync(raw)) unlinkSync(raw);
    } catch {}
  }

  /**
   * Resolve a stored snapshotPath to its current location.
   *
   * Snapshots used to live in ~/.microsandbox/snapshots/. Once the runtime
   * abstraction landed they moved to ~/.devic-sandbox/snapshots/. To keep
   * existing instances functional we transparently fall back to the legacy
   * path when the new one is missing.
   */
  private resolveSnapshotPath(stored: string): string {
    if (existsSync(stored)) return stored;
    if (stored.includes('/.microsandbox/snapshots/')) {
      const migrated = stored.replace(
        '/.microsandbox/snapshots/',
        '/.devic-sandbox/snapshots/',
      );
      if (existsSync(migrated)) return migrated;
    }
    if (stored.includes('/.devic-sandbox/snapshots/')) {
      const legacy = stored.replace(
        '/.devic-sandbox/snapshots/',
        '/.microsandbox/snapshots/',
      );
      if (existsSync(legacy)) return legacy;
    }
    return stored;
  }

  /**
   * Pick the compression codec for full snapshots. The codec also decides WHERE
   * compression runs:
   *   - 'gzip' (default): streamed INSIDE the sandbox (`tar | gzip`), so the CPU
   *     is charged to the tenant's cpu quota, nothing is staged uncompressed,
   *     and restore only needs the universally-present gzip. Scales well on a
   *     shared host.
   *   - 'zstd' (opt-in): the sandbox emits a plain tar and the HOST compresses
   *     it with Node's zlib. Smaller artifacts, but the CPU runs unmetered on
   *     the shared host with a transient uncompressed staging file. Restore
   *     decompresses host-side too, so the base image never needs zstd.
   * 'auto' resolves to gzip (the safe default for a multitenant host).
   */
  private resolveCodec(): Codec {
    const want = this.config.snapshots?.compression ?? 'auto';
    if (want !== 'zstd') return 'gzip';
    const hasZstd = typeof (zlib as any).createZstdCompress === 'function';
    if (!hasZstd) {
      this.logger.warn(
        'snapshots.compression=zstd but this Node build has no zstd support; falling back to gzip',
      );
      return 'gzip';
    }
    return 'zstd';
  }

  private extFor(scope: SnapshotScope, codec: Codec): string {
    if (scope === 'workdir') return 'tar.gz';
    return codec === 'zstd' ? 'tar.zst' : 'tar.gz';
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(
    dto: CreateSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const sandboxDoc = await this.findSandbox(dto.sandboxId, scope);
    if (sandboxDoc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(
        `Sandbox is not running (status: ${sandboxDoc.status})`,
      );
    }

    await this.resourceUsage.assertDiskAvailable();

    const sandbox = await this.getSandboxInstance(sandboxDoc);
    const captureScope: SnapshotScope =
      dto.scope ?? this.config.snapshots?.defaultScope ?? 'full';
    const codec: Codec = captureScope === 'full' ? this.resolveCodec() : 'gzip';

    const snapshotId = nanoid(12);
    const snapshotFileName = `${snapshotId}.${this.extFor(captureScope, codec)}`;
    const snapshotPath = join(SNAPSHOTS_DIR, snapshotFileName);

    const doc = await this.snapshotRepo.create(
      {
        snapshotId,
        sandboxId: sandboxDoc.sandboxId,
        name: dto.name || `snapshot-${snapshotId}`,
        description: dto.description || '',
        status: SnapshotStatus.CREATING,
        image: sandboxDoc.image,
        workdir: sandboxDoc.workdir,
        scope: captureScope,
        compression: codec,
        cpus: sandboxDoc.cpus,
        memoryMib: sandboxDoc.memoryMib,
        envVars: sandboxDoc.envVars ?? {},
        ports: sandboxDoc.ports ?? {},
        exposedHttpPort: sandboxDoc.exposedHttpPort,
        snapshotPath,
        sizeBytes: 0,
        metadata: {
          sourceSandboxName: sandboxDoc.name,
          currentCwd: sandboxDoc.currentCwd,
        },
      } as any,
      scope,
    );

    // Async mode hands back the `creating` document straight away and captures
    // in the background: a full capture of a large filesystem runs for minutes,
    // and a proxy that times the request out mid-capture leaves the caller
    // guessing (and, if it then stops the sandbox, kills the tar). Callers poll
    // GET /snapshots/:id for the outcome.
    if (dto.async) {
      void this.runCreateCapture(
        doc,
        sandbox,
        sandboxDoc,
        captureScope,
        codec,
        snapshotPath,
        scope,
      ).catch(() => undefined);
      return doc;
    }

    return this.runCreateCapture(
      doc,
      sandbox,
      sandboxDoc,
      captureScope,
      codec,
      snapshotPath,
      scope,
    );
  }

  private async runCreateCapture(
    doc: SnapshotDocument,
    sandbox: RuntimeSandbox,
    sandboxDoc: SandboxDocument,
    captureScope: SnapshotScope,
    codec: Codec,
    snapshotPath: string,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const snapshotId = doc.snapshotId;
    const tmpPath = this.tempCapturePath(snapshotPath, snapshotId);
    // Same protection as a persist: while we read this container's filesystem,
    // nothing may stop or remove it.
    await this.markSandboxSaving(sandboxDoc, snapshotId);

    try {
      this.logger.log(
        `Creating ${captureScope} snapshot ${snapshotId} from sandbox ${sandboxDoc.sandboxId}...`,
      );

      let deletes: string[] = [];
      let captureMeta: Record<string, any> = {};

      if (captureScope === 'full') {
        const result = await this.captureFullToHost(
          sandbox,
          sandboxDoc.workdir,
          snapshotId,
          codec,
          tmpPath,
        );
        deletes = result.deletes;
        captureMeta = result.stats;
      } else {
        await this.captureWorkdirToHost(
          sandbox,
          sandboxDoc.workdir,
          snapshotId,
          tmpPath,
        );
      }

      const sizeBytes = this.commitCapture(tmpPath, snapshotPath);

      const updated = await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        {
          $set: {
            status: SnapshotStatus.READY,
            sizeBytes,
            ...(captureScope === 'full'
              ? {
                  'metadata.deletes': this.capDeletes(deletes),
                  'metadata.fullCapture': captureMeta,
                }
              : {}),
          },
          // Every capture invalidates whatever image exists for this snapshot.
          $inc: { persistVersion: 1 },
        },
        scope,
      );

      this.logger.log(
        `Snapshot ${snapshotId} (${captureScope}/${codec}) created (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );

      // Background: the tarball above is the artifact of record and the
      // snapshot is already usable. The image only makes the next restore
      // faster, so nobody waits for it.
      this.imageService.scheduleBuild(updated!);

      return updated!;
    } catch (err) {
      await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SnapshotStatus.FAILED } },
        scope,
      );
      // Best-effort cleanup of a partially written artifact.
      this.discardCapture(tmpPath);
      try {
        if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
      } catch {}
      this.logger.error(
        `Snapshot ${snapshotId} failed: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      await this.clearSandboxSaving(sandboxDoc);
    }
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------

  async restore(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    return this.restoreInternal(snapshotId, dto, scope, {
      skipMemoryCheck: false,
      hotReserved: false,
    });
  }

  /**
   * Provision a hot-reserve sandbox from a snapshot, bypassing the standard
   * memory check (the hot pool service already accounts for the slice it owns).
   * The sandbox is marked `hotReserved=true` and gets a far-future expiresAt
   * so the TTL service ignores it. Snapshot link is intentionally dropped —
   * a hot sandbox that is later claimed must not auto-persist back to the
   * pool's source snapshot.
   */
  async provisionHotReserve(
    snapshotId: string,
    overrides: { cpus?: number; memoryMib?: number },
  ): Promise<SandboxDocument> {
    return this.restoreInternal(
      snapshotId,
      {
        cpus: overrides.cpus,
        memoryMib: overrides.memoryMib,
        ttlSeconds: 60 * 60 * 24 * 365, // 1 year — effectively "no TTL"
        linked: false,
      },
      {},
      {
        skipMemoryCheck: true,
        hotReserved: true,
      },
    );
  }

  private async restoreInternal(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
    options: { skipMemoryCheck: boolean; hotReserved: boolean },
  ): Promise<SandboxDocument> {
    const snapshot = await this.findById(snapshotId, scope);

    // Its very first capture is still running: same situation as a re-save,
    // except there is no previous version to fall back on — say so with the
    // same code so callers handle one case, and let `force` fall through to the
    // "not ready" error below rather than pretending there is something to
    // restore.
    if (snapshot.status === SnapshotStatus.CREATING && !dto.force) {
      throw new ConflictException({
        message:
          'This snapshot is still being captured for the first time. There is ' +
          'no previous version to start from yet.',
        code: 'SNAPSHOT_SAVE_IN_PROGRESS',
        firstCapture: true,
        snapshotId: snapshot.snapshotId,
      });
    }

    if (snapshot.status !== SnapshotStatus.READY) {
      throw new BadRequestException(
        `Snapshot is not ready (status: ${snapshot.status})`,
      );
    }

    // A save in flight means the artifact on disk is still the PREVIOUS
    // capture. Restoring from it is a legitimate choice (it is complete and
    // consistent), but never a silent one: the caller would get a sandbox that
    // is missing whatever the running save is about to commit.
    if (snapshot.saveState === SnapshotSaveState.SAVING && !dto.force) {
      throw new ConflictException({
        message:
          'A save into this snapshot is still in progress. Restore with ' +
          'force=true to start from the last saved version instead.',
        code: 'SNAPSHOT_SAVE_IN_PROGRESS',
        snapshotId: snapshot.snapshotId,
        savingSince: snapshot.savingSince,
        savingSandboxId: snapshot.savingSandboxId,
      });
    }

    const onDiskPath = this.resolveSnapshotPath(snapshot.snapshotPath);
    if (!existsSync(onDiskPath)) {
      throw new BadRequestException('Snapshot file not found on disk');
    }

    // Documents created before scoped snapshots existed have no `scope` field;
    // they are workdir-only tarballs, so default reads to 'workdir'.
    const restoreScope: SnapshotScope =
      (snapshot.scope as SnapshotScope) ?? 'workdir';
    const codec: Codec = (snapshot.compression as Codec) ?? 'gzip';

    const defaults = this.config.defaults;
    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const restoreMemoryMib = dto.memoryMib ?? snapshot.memoryMib;

    if (!options.skipMemoryCheck) {
      await this.resourceUsage.assertMemoryAvailable(restoreMemoryMib);
    }

    const isLinked = dto.linked !== false; // default true
    const exposedHttpPort = dto.exposedHttpPort ?? snapshot.exposedHttpPort;

    // When ingress is enabled and the runtime is microsandbox, the public
    // proxy reaches the sandbox over a forwarded host port — same reservation
    // logic as a fresh create.
    let ports = snapshot.ports ?? {};
    if (
      !options.hotReserved &&
      this.ingressService?.isEnabled() &&
      this.config.runtime.type === 'microsandbox'
    ) {
      const upstreamPort =
        exposedHttpPort ?? this.config.ingress?.defaultUpstreamPort ?? 80;
      const alreadyMapped = Object.values(ports).some(
        (guest) => Number(guest) === upstreamPort,
      );
      if (!alreadyMapped) {
        const hostPort = await this.findFreeHostPort();
        ports = { ...ports, [String(hostPort)]: upstreamPort };
      }
    }

    const sandboxDoc = await this.sandboxRepo.create(
      {
        sandboxId,
        name: containerName,
        status: SandboxStatus.CREATING,
        image: snapshot.image,
        workdir: snapshot.workdir,
        currentCwd: snapshot.metadata?.currentCwd ?? snapshot.workdir,
        cpus: dto.cpus ?? snapshot.cpus,
        memoryMib: dto.memoryMib ?? snapshot.memoryMib,
        envVars: snapshot.envVars ?? {},
        ports,
        exposedHttpPort,
        ttlSeconds,
        expiresAt,
        // Never for a pool pod: it must expire on the pool's terms, and the
        // flag is written for real at claim time.
        autoExtend: options.hotReserved ? false : (dto.autoExtend ?? false),
        ...(isLinked ? { snapshotId: snapshot.snapshotId } : {}),
        hotReserved: options.hotReserved,
        commandCount: 0,
        recentCommands: [],
        metadata: {
          restoredFrom: snapshot.snapshotId,
          restoredAt: new Date().toISOString(),
          linked: isLinked,
          ...(options.hotReserved
            ? { hotPool: true, hotPoolSnapshotId: snapshot.snapshotId }
            : {}),
        },
      } as any,
      scope,
    );

    // Serve from the pre-built image when one matches this exact snapshot
    // version, which turns the restore into a plain container create. Checked
    // per restore rather than cached: the image may have been evicted to keep
    // the cache under its cap, or pruned out of band.
    const fromImage = await this.imageService.isUsable(snapshot);

    try {
      const sandbox = await this.runtime.create({
        name: containerName,
        image: fromImage ? snapshot.imageRef! : snapshot.image,
        workdir: snapshot.workdir,
        cpus: dto.cpus ?? snapshot.cpus,
        memoryMib: dto.memoryMib ?? snapshot.memoryMib,
        env: snapshot.envVars ?? {},
        ports,
        networkPolicy: 'allow-all',
        // The container now starts from base+content, but this sandbox's own
        // snapshots must still be diffs against the base alone. Without this
        // the next capture would record only what changed after the restore,
        // and replaying that tarball onto the base image would silently lose
        // everything the snapshot already held.
        ...(fromImage ? { baselineImage: snapshot.image } : {}),
      });
      await this.registry.register(sandboxId, containerName, ttlSeconds);

      if (!fromImage) {
        if (restoreScope === 'full') {
          await this.restoreFull(
            sandbox,
            snapshot.workdir,
            sandboxId,
            onDiskPath,
            codec,
            (snapshot.metadata?.deletes as string[]) ?? [],
          );
        } else {
          await this.restoreWorkdir(
            sandbox,
            snapshot.workdir,
            sandboxId,
            onDiskPath,
          );
        }
      } else {
        await this.imageService.markUsed(snapshot);
      }

      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        {
          $set: {
            status: SandboxStatus.RUNNING,
            'metadata.restoredFromImage': fromImage,
          },
        },
        scope,
      );

      this.logger.log(
        `Sandbox ${sandboxId} restored from ${restoreScope} snapshot ${snapshotId}` +
          (fromImage ? ' (image)' : ' (tarball)'),
      );

      // Bring the snapshot's service back up.
      //
      // Deliberately here, AFTER the filesystem is in place, rather than
      // relying on the container's entrypoint: a tarball restore starts the
      // container and only then unpacks into it, so anything the snapshot
      // changed about the boot path has already been skipped by the time it
      // lands. Running it here is the only point that behaves the same whether
      // the restore came from the image or the tarball.
      await this.runStartCommand(sandbox, snapshot, sandboxId);

      const updated = await this.sandboxRepo.findById(
        (sandboxDoc as any)._id.toString(),
        scope,
      );
      // Hot-reserve sandboxes stay unpublished until they are claimed — the
      // claim path publishes them, and idle pool entries must not hold
      // public subdomains.
      if (options.hotReserved) return updated!;
      return await this.publishIfEnabled(updated!, scope);
    } catch (err) {
      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.FAILED } },
        scope,
      );
      throw err;
    }
  }

  /**
   * Publish the restored sandbox under its public subdomain when ingress is
   * enabled, persisting subdomain/publicUrl/internalEndpoint on the document.
   * No-op (returns the input) when ingress is disabled or publish fails.
   */
  private async publishIfEnabled(
    sandbox: SandboxDocument,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    if (!this.ingressService?.isEnabled()) return sandbox;
    try {
      const result = await this.ingressService.publish(sandbox);
      if (!result) return sandbox;
      await this.sandboxRepo.updateById(
        (sandbox as any)._id.toString(),
        {
          $set: {
            subdomain: result.subdomain,
            publicUrl: result.publicUrl,
            internalEndpoint: result.internalEndpoint,
          },
        },
        scope,
      );
      const refreshed = await this.sandboxRepo.findById(
        (sandbox as any)._id.toString(),
        scope,
      );
      return refreshed ?? sandbox;
    } catch (err) {
      this.logger.warn(
        `Ingress publish failed for ${sandbox.sandboxId}: ${(err as Error).message}`,
      );
      return sandbox;
    }
  }

  private async findFreeHostPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          srv.close(() => reject(new Error('Failed to allocate ephemeral port')));
          return;
        }
        const port = addr.port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });
  }

  async findAll(
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number; sandboxId?: string },
  ): Promise<PaginatedResponse<SnapshotDocument>> {
    const filter: Record<string, any> = {};
    if (options?.sandboxId) filter.sandboxId = options.sandboxId;
    return this.snapshotRepo.find(filter, scope, options);
  }

  async findById(
    id: string,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const doc =
      (await this.snapshotRepo.findOne({ snapshotId: id } as any, scope)) ??
      (await this.snapshotRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Snapshot ${id} not found`);
    return doc;
  }

  /**
   * Update a snapshot's public identity: its subdomain and whether visiting it
   * revives it. Both are metadata about how the snapshot is served, so nothing
   * here touches the artifact or any running sandbox.
   *
   * A slug change only takes effect on the NEXT publish. A sandbox already
   * serving this snapshot keeps answering on the old subdomain until it is
   * republished, because the live route lives in Redis and rewriting it here
   * would need the sandbox's upstream address, which is the ingress's business
   * and not this service's.
   */
  async update(
    id: string,
    dto: UpdateSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    const doc = await this.findById(id, scope);

    const set: Record<string, any> = {};
    const unset: Record<string, any> = {};

    if (dto.slug !== undefined) {
      if (dto.slug === null || dto.slug.trim() === '') {
        // Releasing the slug is not "no subdomain": it falls back to the label
        // derived from the id, so the snapshot stays reachable.
        unset.slug = '';
      } else {
        const slug = dto.slug.trim().toLowerCase();
        const clash = await this.snapshotRepo.findBySubdomain(slug);
        if (clash && clash.snapshotId !== doc.snapshotId) {
          throw new ConflictException({
            code: 'SUBDOMAIN_TAKEN',
            message: `Subdomain "${slug}" is already serving snapshot ${clash.snapshotId}`,
          });
        }
        set.slug = slug;
      }
    }

    if (dto.autoRestart !== undefined) set.autoRestart = dto.autoRestart;

    if (dto.startCommand !== undefined) {
      const cmd = dto.startCommand?.trim();
      if (cmd) set.startCommand = cmd;
      else unset.startCommand = '';
    }

    if (!Object.keys(set).length && !Object.keys(unset).length) return doc;

    const update: Record<string, any> = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;

    try {
      await this.snapshotRepo.updateById((doc as any)._id.toString(), update, scope);
    } catch (err) {
      // The unique index is the real arbiter: two concurrent updates can both
      // pass the check above and only one can win.
      if ((err as any)?.code === 11000) {
        throw new ConflictException({
          code: 'SUBDOMAIN_TAKEN',
          message: `Subdomain "${set.slug}" is already taken`,
        });
      }
      throw err;
    }

    return this.findById(id, scope);
  }

  async destroy(id: string, scope: ExtensionScope): Promise<void> {
    const doc = await this.findById(id, scope);

    // Best-effort: a sandbox restored from this image still holds it and the
    // daemon will refuse. The cache sweep reclaims it once that sandbox is
    // gone, so a failure here leaks nothing permanently.
    await this.imageService.discard(doc).catch((err) =>
      this.logger.warn(
        `Could not drop image for snapshot ${doc.snapshotId}: ${(err as Error).message}`,
      ),
    );

    const onDiskPath = this.resolveSnapshotPath(doc.snapshotPath);
    try {
      if (existsSync(onDiskPath)) {
        unlinkSync(onDiskPath);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete snapshot file ${onDiskPath}: ${(err as Error).message}`,
      );
    }

    await this.snapshotRepo.deleteById((doc as any)._id.toString(), scope);
    this.logger.log(`Snapshot ${doc.snapshotId} destroyed`);
  }

  // ---------------------------------------------------------------------------
  // ZIP export / import
  // ---------------------------------------------------------------------------

  /**
   * Stream the snapshot contents as a ZIP archive. The on-disk tarball is
   * converted entry by entry, so memory stays flat for large snapshots.
   * Symlinks/devices have no ZIP representation and are skipped (logged).
   */
  async downloadAsZip(
    id: string,
    scope: ExtensionScope,
  ): Promise<{ stream: Readable; filename: string }> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SnapshotStatus.READY) {
      throw new BadRequestException(
        `Snapshot is not ready (status: ${doc.status})`,
      );
    }

    const onDisk = this.resolveSnapshotPath(doc.snapshotPath);
    if (!existsSync(onDisk)) {
      throw new NotFoundException(
        `Snapshot ${doc.snapshotId} artifact not found on disk`,
      );
    }

    const codec: Codec = doc.compression === 'zstd' ? 'zstd' : 'gzip';
    if (
      codec === 'zstd' &&
      typeof (zlib as any).createZstdDecompress !== 'function'
    ) {
      throw new BadRequestException(
        'This snapshot is zstd-compressed but the server Node build has no zstd support',
      );
    }

    const { outputStream, done } = tarballToZipStream(onDisk, codec);
    done
      .then(({ files, skipped }) => {
        if (skipped > 0) {
          this.logger.warn(
            `ZIP export of snapshot ${doc.snapshotId}: ${skipped} non-file entries (symlinks/devices) were skipped (${files} files exported)`,
          );
        }
      })
      .catch((err) =>
        this.logger.error(
          `ZIP export of snapshot ${doc.snapshotId} failed mid-stream: ${(err as Error).message}`,
        ),
      );

    const safeName = (doc.name || 'snapshot').replace(/[^\w.-]+/g, '_');
    return { stream: outputStream, filename: `${safeName}-${doc.snapshotId}.zip` };
  }

  /**
   * Create a workdir-scope snapshot from an uploaded ZIP of files: the archive
   * is repacked into the tar.gz layout restore expects, so its entries land in
   * the working directory of any sandbox restored from it. The document
   * self-references `sandboxId` (there is no source sandbox) and is flagged
   * with `metadata.importedFromZip`.
   */
  async importFromZip(
    file: Express.Multer.File,
    dto: ImportSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument> {
    if (!file) {
      throw new BadRequestException("multipart field 'file' is required");
    }

    await this.resourceUsage.assertDiskAvailable();

    const snapshotId = nanoid(12);
    const snapshotPath = join(SNAPSHOTS_DIR, `${snapshotId}.tar.gz`);

    try {
      const { files } = await zipToTarGz(file.path, snapshotPath);

      let sizeBytes = 0;
      try {
        sizeBytes = statSync(snapshotPath).size;
      } catch {}

      const doc = await this.snapshotRepo.create(
        {
          snapshotId,
          sandboxId: snapshotId,
          name: dto.name || `imported-${snapshotId}`,
          description: dto.description || '',
          status: SnapshotStatus.READY,
          image: dto.image || this.config.defaults.defaultImage,
          workdir: dto.workdir || '/workspace',
          scope: 'workdir',
          compression: 'gzip',
          cpus: this.config.defaults.defaultCpus,
          memoryMib: this.config.defaults.defaultMemoryMib,
          envVars: {},
          ports: {},
          snapshotPath,
          sizeBytes,
          metadata: {
            importedFromZip: true,
            originalFilename: file.originalname,
            fileCount: files,
          },
        } as any,
        scope,
      );

      this.logger.log(
        `Snapshot ${snapshotId} imported from ZIP '${file.originalname}' (${files} files, ${sizeBytes} bytes)`,
      );
      return doc;
    } catch (err) {
      try {
        if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
      } catch {}
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Could not import ZIP: ${(err as Error).message}`,
      );
    } finally {
      try {
        if (file?.path && existsSync(file.path)) unlinkSync(file.path);
      } catch {}
    }
  }

  /**
   * Persist the current sandbox filesystem state back to its linked snapshot.
   * Called automatically when a snapshot-linked sandbox is stopped or expires.
   * Re-captures with the same scope/codec the snapshot was created with.
   */
  async persistToSnapshot(
    sandboxDoc: SandboxDocument,
    targetSnapshotId?: string,
    options: PersistOptions = {},
  ): Promise<SnapshotSaveOutcome> {
    const startedAt = Date.now();
    // Callers may name the snapshot instead of relying on the link the sandbox
    // was restored with — the only way to save a sandbox restored unlinked.
    const snapshotId = targetSnapshotId ?? sandboxDoc.snapshotId;
    if (!snapshotId) return 'skipped';

    let snapshotDoc: SnapshotDocument | null;
    try {
      snapshotDoc = await this.snapshotRepo.findOne(
        { snapshotId } as any,
        {},
      );
    } catch {
      snapshotDoc = null;
    }

    if (!snapshotDoc || snapshotDoc.status !== SnapshotStatus.READY) {
      this.logger.warn(
        `Snapshot ${snapshotId} not found or not ready, skipping persist`,
      );
      return 'skipped';
    }

    // Claim the snapshot before touching anything. Two sessions saving into the
    // same snapshot would interleave their tars over one file; the loser is
    // told so rather than silently corrupting the winner's artifact.
    const claimed = await this.snapshotRepo.updateOne(
      {
        snapshotId: snapshotDoc.snapshotId,
        saveState: { $ne: SnapshotSaveState.SAVING },
      } as any,
      {
        $set: {
          saveState: SnapshotSaveState.SAVING,
          savingSince: new Date(),
          savingSandboxId: sandboxDoc.sandboxId,
          saveStage: SnapshotSaveStage.CLAIMING,
          saveStageSince: new Date(),
        },
      },
      {},
    );
    if (!claimed) {
      this.logger.warn(
        `Snapshot ${snapshotDoc.snapshotId} is already being saved by ` +
          `${snapshotDoc.savingSandboxId ?? 'another sandbox'}; skipping ` +
          `persist from ${sandboxDoc.sandboxId}`,
      );
      return 'conflict';
    }
    snapshotDoc = claimed;

    // Mirrored on the sandbox so stop/destroy can refuse to tear down a
    // container whose filesystem is being read right now.
    await this.markSandboxSaving(sandboxDoc, snapshotDoc.snapshotId);

    const persistScope: SnapshotScope =
      (snapshotDoc.scope as SnapshotScope) ?? 'workdir';
    const codec: Codec = (snapshotDoc.compression as Codec) ?? 'gzip';

    // Always write to the canonical (current) location even if the snapshot
    // was originally created under the legacy path.
    const targetPath = snapshotDoc.snapshotPath.includes(
      '/.microsandbox/snapshots/',
    )
      ? snapshotDoc.snapshotPath.replace(
          '/.microsandbox/snapshots/',
          '/.devic-sandbox/snapshots/',
        )
      : snapshotDoc.snapshotPath;
    const tmpPath = this.tempCapturePath(targetPath, sandboxDoc.sandboxId);

    try {
      this.logger.log(
        `Persisting sandbox ${sandboxDoc.sandboxId} to ${persistScope} snapshot ${snapshotDoc.snapshotId}...`,
      );

      const containerName =
        (await this.registry.get(sandboxDoc.sandboxId)) ?? sandboxDoc.name;
      const handle = await this.runtime.get(containerName);
      if (!handle || handle.status !== 'running') {
        this.logger.warn(
          `Sandbox ${sandboxDoc.sandboxId} not running (status: ${handle?.status ?? 'missing'}), skipping persist`,
        );
        return 'skipped';
      }
      const sandbox = await handle.connect();

      // Seal the writable layer instead of walking, tarring and replaying it.
      // Returns null when it declines or fails, and the tarball path below runs
      // exactly as it always has — the artifact of record is never at risk.
      const committed = await this.persistByCommit(
        snapshotDoc,
        sandboxDoc,
        sandbox,
        containerName,
        persistScope,
        startedAt,
        options,
      );
      if (committed) return committed;

      if (targetPath !== snapshotDoc.snapshotPath && !existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      }

      await this.setSaveStage(snapshotDoc, SnapshotSaveStage.CAPTURING);

      let deletes: string[] = [];
      let captureMeta: Record<string, any> = {};

      if (persistScope === 'full') {
        const result = await this.captureFullToHost(
          sandbox,
          sandboxDoc.workdir,
          sandboxDoc.sandboxId,
          codec,
          tmpPath,
        );
        deletes = result.deletes;
        captureMeta = result.stats;
      } else {
        await this.captureWorkdirToHost(
          sandbox,
          sandboxDoc.workdir,
          sandboxDoc.sandboxId,
          tmpPath,
        );
      }

      // The previous artifact stays readable until this rename: anything that
      // restored (with force) while we were capturing got a whole tarball.
      const sizeBytes = this.commitCapture(tmpPath, targetPath);

      // If we migrated the path, drop the legacy file to avoid drift.
      if (
        targetPath !== snapshotDoc.snapshotPath &&
        existsSync(snapshotDoc.snapshotPath)
      ) {
        try {
          unlinkSync(snapshotDoc.snapshotPath);
        } catch {}
      }

      // `sizeBytes` comes from the commit above: it measures the file that was
      // actually renamed into place, not whatever happens to be at the path by
      // the time we look.
      const persisted = await this.snapshotRepo.updateById(
        (snapshotDoc as any)._id.toString(),
        {
          $set: {
            sizeBytes,
            snapshotPath: targetPath,
            'metadata.lastPersistedFrom': sandboxDoc.sandboxId,
            'metadata.lastPersistedAt': new Date().toISOString(),
            'metadata.currentCwd': sandboxDoc.currentCwd,
            // A previous failure is history now.
            'metadata.lastSaveError': null,
            'metadata.lastSaveErrorAt': null,
            lastSaveMethod: 'tarball',
            lastSaveDurationMs: Date.now() - startedAt,
            // This path IS the tarball, so it is current by construction.
            tarballVersion: (snapshotDoc.persistVersion ?? 0) + 1,
            ...(persistScope === 'full'
              ? {
                  'metadata.deletes': this.capDeletes(deletes),
                  'metadata.fullCapture': captureMeta,
                }
              : {}),
          },
          // The tarball just changed, so any existing image is now stale.
          // Bumping first means a restore landing between here and the rebuild
          // sees a version mismatch and falls back to the tarball rather than
          // serving the previous contents.
          $inc: { persistVersion: 1 },
        },
        {},
      );

      this.logger.log(
        `Snapshot ${snapshotDoc.snapshotId} updated from sandbox ${sandboxDoc.sandboxId} (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );

      // Only now, with the tarball renamed into place, can a rebuild publish an
      // image: it replays the artifact of record, so scheduling it any earlier
      // would bake the PREVIOUS capture under the new persistVersion.
      if (persisted) this.imageService.scheduleBuild(persisted);
      return 'saved';
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `Failed to persist snapshot ${snapshotDoc.snapshotId}: ${message}`,
      );
      // Nobody is waiting on this call any more — it runs after the response
      // went out — so the failure has to be readable from the snapshot itself,
      // or the session's work is lost without anyone being told.
      try {
        await this.snapshotRepo.updateById(
          (snapshotDoc as any)._id.toString(),
          {
            $set: {
              'metadata.lastSaveError': message,
              'metadata.lastSaveErrorAt': new Date().toISOString(),
              'metadata.lastSaveErrorFrom': sandboxDoc.sandboxId,
            },
          },
          {},
        );
      } catch {}
      return 'failed';
    } finally {
      this.discardCapture(tmpPath);
      await this.releaseSnapshotSave(snapshotDoc, sandboxDoc);
    }
  }

  /**
   * Save by sealing the sandbox's writable layer as the snapshot's image.
   *
   * Returns the outcome when it took the save, or `null` to decline — in which
   * case the caller runs the tarball path unchanged. Declining is not failure:
   * it is how a workdir snapshot, a runtime without commits, or a layer stack
   * that has run out of headroom keeps working exactly as before.
   *
   * Why this is the fast path: the runtime already holds the delta as the
   * container's writable layer. The tarball path re-derives it by walking the
   * filesystem, tarring it, compressing it, copying it out, and then replaying
   * it into a fresh container to rebuild the image — measured ~115 s against
   * 14.9 s for a 1.2 GB delta, of which 83.8 s was gzip alone.
   *
   * It also removes the window this design has always had. The tarball path
   * bumps `persistVersion` when the artifact lands and rebuilds the image
   * afterwards, so for ~30 s the image is stale, `isUsable()` says no, and
   * every restore falls back to replaying a tarball. Here the commit IS the new
   * version: one write, no window.
   */
  private async persistByCommit(
    snapshotDoc: SnapshotDocument,
    sandboxDoc: SandboxDocument,
    sandbox: RuntimeSandbox,
    containerName: string,
    persistScope: SnapshotScope,
    startedAt: number,
    options: PersistOptions,
  ): Promise<SnapshotSaveOutcome | null> {
    if (persistScope !== 'full') return null;

    const docId = (snapshotDoc as any)._id.toString();

    // Everything below is inside the net, guards included: this method promises
    // that declining costs nothing, and a guard that threw would instead take
    // down a save the tarball path was perfectly able to complete.
    try {
      if (!this.imageService.canCommitLive()) return null;

      // Committing on top of an image that is already deep would produce one
      // the runtime refuses to start. Hand this save to the tarball path and
      // let the consolidation pass give the headroom back.
      if (this.imageService.isOutOfLayerHeadroom(snapshotDoc)) {
        this.logger.log(
          `Snapshot ${snapshotDoc.snapshotId} has ${snapshotDoc.imageLayers} layers; ` +
            'saving via the tarball and scheduling a consolidation',
        );
        this.imageService.scheduleConsolidation(snapshotDoc);
        return null;
      }

      // Only for a sandbox that is being torn down: the caches are
      // regenerable, but deleting them under a session that is still running
      // is not this code's call to make.
      if (options.terminal) {
        await this.setSaveStage(snapshotDoc, SnapshotSaveStage.CLEANING);
        await this.dropRegenerableCaches(sandbox, snapshotDoc.snapshotId);
      }

      await this.setSaveStage(snapshotDoc, SnapshotSaveStage.COMMITTING);
      const ref = this.imageService.refFor(snapshotDoc.snapshotId);
      const info = await this.runtime.commitImage!(containerName, ref, {
        labels: { 'devic-sandbox.snapshot': snapshotDoc.snapshotId },
        // The freeze lasts the whole commit. Free for a container about to be
        // destroyed; not something to inflict on one still serving requests.
        pause: options.terminal === true,
      });

      // The claim makes this the only writer, so the next version can be
      // computed and written rather than incremented — which is what lets the
      // image and the version it describes land in a single update.
      const nextVersion = (snapshotDoc.persistVersion ?? 0) + 1;

      // First commit-based save of a snapshot that predates the field: the
      // tarball sitting on disk holds the version we are about to leave behind,
      // so record that rather than let it stay unset. Without this the lag is
      // unknowable from the document alone, and the reader has to keep guessing
      // forever.
      const backfillTarballVersion =
        snapshotDoc.tarballVersion === undefined ||
        snapshotDoc.tarballVersion === null
          ? { tarballVersion: snapshotDoc.persistVersion ?? 0 }
          : {};

      const persisted = await this.snapshotRepo.updateById(
        docId,
        {
          $set: {
            ...backfillTarballVersion,
            persistVersion: nextVersion,
            imageState: 'ready',
            imageRef: info.ref,
            imageSourceVersion: nextVersion,
            imageBuiltAt: new Date(),
            imageSizeBytes: info.uniqueSizeBytes,
            imageLayers: info.layers,
            imageGeneration: (snapshotDoc.imageGeneration ?? 0) + 1,
            lastSaveMethod: 'commit',
            lastSaveDurationMs: Date.now() - startedAt,
            'metadata.lastPersistedFrom': sandboxDoc.sandboxId,
            'metadata.lastPersistedAt': new Date().toISOString(),
            'metadata.currentCwd': sandboxDoc.currentCwd,
            'metadata.lastSaveError': null,
            'metadata.lastSaveErrorAt': null,
          },
        },
        {},
      );

      this.logger.log(
        `Snapshot ${snapshotDoc.snapshotId} committed from sandbox ` +
          `${sandboxDoc.sandboxId} (${info.layers} layers, ` +
          `${(info.uniqueSizeBytes / 1048576).toFixed(1)} MB unique, ` +
          `${Date.now() - startedAt} ms)`,
      );

      // The tarball is now behind. It stays the artifact of record — export,
      // backups and migration all read it — so the background pass refreshes
      // it, and until it does `tarballVersion` says how far behind it is.
      if (persisted) this.imageService.scheduleConsolidation(persisted);
      return 'saved';
    } catch (err) {
      // The tarball on disk is untouched and still restorable, so the honest
      // move is to fall through to the path that produces it rather than fail
      // the save over an optimisation.
      this.logger.warn(
        `Commit-based save of snapshot ${snapshotDoc.snapshotId} failed, ` +
          `falling back to the tarball: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Delete the caches a full snapshot excludes, before the layer is sealed.
   *
   * The tarball path filters these out of its file list; a commit has no list,
   * so they have to leave the container. Never throws: an image carrying a
   * package cache is worse than it needs to be, not broken.
   */
  private async dropRegenerableCaches(
    sandbox: RuntimeSandbox,
    snapshotId: string,
  ): Promise<void> {
    const prefixes = cleanupPrefixes({
      cleanup: this.config.snapshots?.cleanup ?? 'conservative',
      extra: this.config.snapshots?.excludePaths,
    });
    if (!prefixes.length) return;
    try {
      const res = await sandbox.exec(
        `rm -rf ${prefixes.map((p) => sh(p)).join(' ')} 2>/dev/null; exit 0`,
      );
      if (res.code !== 0) {
        this.logger.debug(
          `Cache cleanup for ${snapshotId} exited ${res.code}: ${res.stderr}`,
        );
      }
    } catch (err) {
      this.logger.debug(
        `Cache cleanup for ${snapshotId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Rebuild a snapshot's tarball from its image, so the portable artifact
   * catches up with what a commit-based save published.
   *
   * The tarball is not an optimisation: `downloadAsZip`, backups and moving a
   * snapshot between hosts all read it, and it is the copy that survives the
   * daemon losing its images. A commit-based save leaves it behind by one
   * version, and this is what closes that gap.
   *
   * Runs against a throwaway container of the image rather than the original
   * sandbox, which by now is usually gone — and would be the wrong source
   * anyway, since the image is what the version describes.
   */
  private async refreshTarballFromImage(
    snapshot: SnapshotDocument,
  ): Promise<SnapshotDocument | null> {
    const version = snapshot.persistVersion ?? 0;
    const imageRef = snapshot.imageRef;
    if (!imageRef) return null;

    const helper = `snaptar-${nanoid(10)}`;
    const codec: Codec = (snapshot.compression as Codec) ?? 'gzip';
    const targetPath = this.resolveSnapshotPath(snapshot.snapshotPath);
    const tmpPath = this.tempCapturePath(targetPath, helper);

    await this.setSaveStage(snapshot, SnapshotSaveStage.TARBALL);

    try {
      await this.runtime.create({
        name: helper,
        image: imageRef,
        workdir: snapshot.workdir,
        cpus: snapshot.cpus,
        memoryMib: snapshot.memoryMib,
        env: snapshot.envVars ?? {},
        // It exists only to be read from.
        networkPolicy: 'deny-all',
        // Diffs must come out relative to the ORIGINAL base, not to the image
        // this container was created from — otherwise the tarball would hold
        // only what changed since the last consolidation and replaying it onto
        // the base would silently drop everything before that.
        baselineImage: snapshot.image,
      });

      const handle = await this.runtime.get(helper);
      if (!handle) throw new Error(`helper ${helper} is not reachable`);
      const sandbox = await handle.connect();

      const result = await this.captureFullToHost(
        sandbox,
        snapshot.workdir,
        helper,
        codec,
        tmpPath,
      );
      const sizeBytes = this.commitCapture(tmpPath, targetPath);

      // Written under the version that was current when the capture STARTED: a
      // save landing meanwhile makes this tarball describe the older content,
      // and claiming otherwise would hide a real lag.
      const updated = await this.snapshotRepo.updateById(
        (snapshot as any)._id.toString(),
        {
          $set: {
            sizeBytes,
            tarballVersion: version,
            'metadata.deletes': this.capDeletes(result.deletes),
            'metadata.fullCapture': result.stats,
          },
        },
        {},
      );

      this.logger.log(
        `Snapshot ${snapshot.snapshotId} tarball refreshed from its image at ` +
          `version ${version} (${(sizeBytes / 1048576).toFixed(1)} MB)`,
      );
      return updated;
    } catch (err) {
      this.logger.warn(
        `Tarball refresh for ${snapshot.snapshotId} failed: ${(err as Error).message}`,
      );
      return null;
    } finally {
      this.discardCapture(tmpPath);
      await this.runtime.remove(helper).catch(() => undefined);
      await this.snapshotRepo
        .updateById(
          (snapshot as any)._id.toString(),
          { $unset: { saveStage: '', saveStageSince: '' } },
          {},
        )
        .catch(() => undefined);
    }
  }

  /** Record where the running save is. Never throws — it is display state. */
  private async setSaveStage(
    snapshotDoc: SnapshotDocument,
    stage: SnapshotSaveStage,
  ): Promise<void> {
    await this.snapshotRepo
      .updateById(
        (snapshotDoc as any)._id.toString(),
        { $set: { saveStage: stage, saveStageSince: new Date() } },
        {},
      )
      .catch(() => undefined);
  }

  /** Flag the sandbox as being captured, so stop/destroy refuse to kill it. */
  private async markSandboxSaving(
    sandboxDoc: SandboxDocument,
    snapshotId: string,
  ): Promise<void> {
    try {
      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { savingSnapshotId: snapshotId } },
        {},
      );
      (sandboxDoc as any).savingSnapshotId = snapshotId;
    } catch {}
  }

  /** Clear the capture flag on the sandbox. Never throws. */
  private async clearSandboxSaving(sandboxDoc: SandboxDocument): Promise<void> {
    try {
      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $unset: { savingSnapshotId: '' } },
        {},
      );
      (sandboxDoc as any).savingSnapshotId = undefined;
    } catch {}
  }

  /**
   * Release the save claim on both documents. Never throws.
   *
   * The stage is cleared with a FILTER, not unconditionally. A commit-based
   * save schedules the background pass before returning, so by the time this
   * runs the snapshot may already be reporting `consolidating` or `tarball` —
   * work that outlives the save by minutes. Wiping it here left the field empty
   * for the whole refresh, which is precisely the long stage worth showing.
   */
  private async releaseSnapshotSave(
    snapshotDoc: SnapshotDocument,
    sandboxDoc: SandboxDocument,
  ): Promise<void> {
    try {
      const id = (snapshotDoc as any)._id.toString();
      await this.snapshotRepo.updateById(
        id,
        {
          $set: { saveState: SnapshotSaveState.IDLE },
          $unset: { savingSince: '', savingSandboxId: '' },
        },
        {},
      );
      await this.snapshotRepo.updateOne(
        { _id: id, saveStage: { $in: FOREGROUND_SAVE_STAGES } } as any,
        { $unset: { saveStage: '', saveStageSince: '' } },
        {},
      );
    } catch (err) {
      this.logger.warn(
        `Could not clear save state on snapshot ${snapshotDoc.snapshotId}: ${(err as Error).message}`,
      );
    }
    await this.clearSandboxSaving(sandboxDoc);
  }

  // ---------------------------------------------------------------------------
  // Capture / restore implementations
  // ---------------------------------------------------------------------------

  /**
   * Workdir-only capture (legacy behaviour). Lightweight tar.gz of the working
   * directory, produced inside the sandbox. Kept byte-for-byte compatible with
   * pre-existing snapshots.
   */
  private async captureWorkdirToHost(
    sandbox: RuntimeSandbox,
    workdir: string,
    id: string,
    hostPath: string,
  ): Promise<void> {
    const guestTarPath = `${workdir}/.devic-runtime-snapshot-${id}.tar.gz`;

    // No `--warning=no-file-changed`: that flag is GNU-only and busybox tar
    // (alpine et al.) treats it as an unrecognized option, prints usage to
    // stderr and silently produces no archive. GNU tar emits the mtime-changed
    // warning to stderr instead, which is harmless; the code-1 exit it triggers
    // is tolerated below.
    const tarResult = await sandbox.exec(
      `tar czf ${guestTarPath} --exclude='./.devic-runtime-*' -C ${workdir} . && [ -s ${guestTarPath} ]`,
    );

    if (tarResult.code >= 2) {
      throw new Error(
        `Snapshot archive not produced (tar code=${tarResult.code}): ${tarResult.stderr || tarResult.stdout}`,
      );
    }

    await sandbox.copyToHost(guestTarPath, hostPath);
    await sandbox.exec(`rm -f ${guestTarPath}`);
  }

  /**
   * Build the shell that tars the listed paths to `outputArgs` (e.g. `-cf -` to
   * stream, or `-cf "$RAW"` to a file), capturing tar's real exit code into
   * `rcPath` even when it runs inside a pipe. GNU tar uses `--no-recursion` so
   * directory members keep their metadata without pulling unchanged children;
   * busybox/alpine tar (no `--no-recursion`) gets a pre-filtered list with real
   * directories dropped (parents are recreated on extract).
   */
  private tarEmitBlock(
    listPath: string,
    filesPath: string,
    rcPath: string,
    outputArgs: string,
  ): string {
    return [
      `if tar --version 2>/dev/null | grep -qi 'GNU tar'; then`,
      `  ( tar --no-recursion -T ${sh(listPath)} ${outputArgs} ; echo $? > ${sh(rcPath)} )`,
      `else`,
      `  while IFS= read -r p; do if [ -d "/$p" ] && [ ! -L "/$p" ]; then :; else printf '%s\\n' "$p"; fi; done < ${sh(listPath)} > ${sh(filesPath)}`,
      `  ( tar -T ${sh(filesPath)} ${outputArgs} ; echo $? > ${sh(rcPath)} )`,
      `fi`,
    ].join('\n');
  }

  /**
   * Full-filesystem capture. Archives only the changed/added paths from
   * `sandbox.diff()` (minus excluded caches). For gzip (default) it compresses
   * in a single streamed pass INSIDE the sandbox (`tar | gzip`) and copies the
   * compressed artifact out — metered, no uncompressed staging. For zstd it
   * emits a plain tar, copies it out and compresses host-side. Returns deleted
   * paths (to replay on restore) plus capture stats.
   *
   * Runtime-agnostic: the tar runs via `docker exec` inside the container, which
   * sees the fully merged filesystem under both `runc` and `sysbox-runc`. The
   * runtime difference is confined to how `sandbox.diff()` enumerates the
   * changed set (docker diff vs in-container manifest); see DockerSandbox.diff().
   */
  private async captureFullToHost(
    sandbox: RuntimeSandbox,
    workdir: string,
    id: string,
    codec: Codec,
    hostPath: string,
  ): Promise<{ deletes: string[]; stats: Record<string, any> }> {
    const cleanup = this.config.snapshots?.cleanup ?? 'conservative';
    const isExcluded = buildExcludeMatcher({
      cleanup,
      extra: this.config.snapshots?.excludePaths,
    });

    const changes = await sandbox.diff();
    const { present, deletes, excludedCount } = partitionChanges(
      changes,
      isExcluded,
    );

    const listPath = `${workdir}/.devic-runtime-snaplist-${id}`;
    const filesPath = `${workdir}/.devic-runtime-snapfiles-${id}`;
    const rcPath = `${workdir}/.devic-runtime-snaprc-${id}`;
    const safeDeletes = deletes.filter(isSafeDeletePath);

    // Degenerate case: nothing changed vs the base image. tar refuses to build
    // an empty archive, so write a sentinel file, include it, and mark it for
    // deletion on restore so it leaves no trace.
    if (present.length === 0) {
      const sentinelRel = `.devic-runtime-snapsentinel-${id}`;
      await sandbox.exec(`: > ${sh(`${workdir}/${sentinelRel}`)}`);
      present.push(`${workdir.replace(/^\/+/, '')}/${sentinelRel}`);
      safeDeletes.push(`${workdir}/${sentinelRel}`);
    }

    await sandbox.writeFile(
      listPath,
      Buffer.from(present.join('\n') + '\n', 'utf-8'),
    );

    const cleanupCmd = `rm -f ${sh(listPath)} ${sh(filesPath)} ${sh(rcPath)}`;

    if (codec === 'gzip') {
      // Stream tar -> gzip in one pass; no uncompressed staging. The compound
      // is grouped so the whole thing pipes into gzip; tar's rc is recovered
      // from rcPath (rc=1 is a benign "file changed while reading" warning).
      const guestGz = `${workdir}/.devic-runtime-snapshot-${id}.tar.gz`;
      const script = [
        'set -u',
        'cd / || exit 90',
        `{ ${this.tarEmitBlock(listPath, filesPath, rcPath, '-cf -')} ; } | gzip -c > ${sh(guestGz)}`,
        `rc=$(cat ${sh(rcPath)} 2>/dev/null || echo 99)`,
        cleanupCmd,
        `if [ "$rc" -ge 2 ]; then echo "tar rc=$rc" >&2; rm -f ${sh(guestGz)}; exit "$rc"; fi`,
        `[ -s ${sh(guestGz)} ] || { echo "empty archive" >&2; exit 5; }`,
        'echo OK',
      ].join('\n');

      const res = await sandbox.exec(script);
      if (res.code >= 2) {
        throw new Error(
          `Full snapshot tar failed (code=${res.code}): ${res.stderr || res.stdout}`,
        );
      }
      await sandbox.copyToHost(guestGz, hostPath);
      await sandbox.exec(`rm -f ${sh(guestGz)}`);

      return {
        deletes: safeDeletes,
        stats: {
          changed: present.length,
          deleted: safeDeletes.length,
          excluded: excludedCount,
          codec,
          where: 'sandbox',
        },
      };
    }

    // zstd: emit a plain tar in the sandbox, compress host-side.
    const rawTar = `${workdir}/.devic-runtime-snapraw-${id}.tar`;
    const script = [
      'set -u',
      'cd / || exit 90',
      this.tarEmitBlock(listPath, filesPath, rcPath, `-cf ${sh(rawTar)}`),
      `rc=$(cat ${sh(rcPath)} 2>/dev/null || echo 99)`,
      cleanupCmd,
      `if [ "$rc" -ge 2 ]; then echo "tar rc=$rc" >&2; rm -f ${sh(rawTar)}; exit "$rc"; fi`,
      `[ -s ${sh(rawTar)} ] || { echo "empty raw tar" >&2; exit 5; }`,
      'echo OK',
    ].join('\n');

    const res = await sandbox.exec(script);
    if (res.code >= 2) {
      throw new Error(
        `Full snapshot tar failed (code=${res.code}): ${res.stderr || res.stdout}`,
      );
    }

    const rawHost = `${hostPath}.rawtar`;
    await sandbox.copyToHost(rawTar, rawHost);
    await sandbox.exec(`rm -f ${sh(rawTar)}`);

    let rawBytes = 0;
    try {
      rawBytes = statSync(rawHost).size;
    } catch {}

    try {
      await this.compressFile(rawHost, hostPath, codec);
    } finally {
      try {
        unlinkSync(rawHost);
      } catch {}
    }

    return {
      deletes: safeDeletes,
      stats: {
        changed: present.length,
        deleted: safeDeletes.length,
        excluded: excludedCount,
        rawBytes,
        codec,
        where: 'host',
      },
    };
  }

  /**
   * Bring a snapshot's public address back to life after a visit found it
   * dormant.
   *
   * Restoring is the second choice, not the first. A sandbox of this snapshot
   * may already be running and have merely lost the address — its route
   * evicted, or deleted by an older sibling of its own snapshot expiring, since
   * the subdomain belongs to the snapshot and every sandbox from it shares the
   * key. Restoring another then puts two sandboxes of one snapshot in the air:
   * they compete for the address and, being linked, race to write themselves
   * back into the snapshot. Republishing the one already up costs nothing and
   * is the entire repair.
   */
  private async wakeRestore(
    snapshotId: string,
    ttlSeconds: number,
  ): Promise<{ sandboxId: string }> {
    const existing = await this.sandboxRepo
      .findRunningFromSnapshot(snapshotId)
      .catch(() => null);

    if (existing) {
      this.logger.log(
        `Republishing running sandbox ${existing.sandboxId} for snapshot ` +
          `${snapshotId} instead of restoring another`,
      );
      await this.publishIfEnabled(existing, {});
      return { sandboxId: existing.sandboxId };
    }

    const sandbox = await this.restore(snapshotId, { ttlSeconds }, {});
    return { sandboxId: sandbox.sandboxId };
  }

  /**
   * Run a snapshot's `startCommand` in a freshly restored sandbox.
   *
   * Detached and not awaited for completion: a start command is a server, so it
   * does not return, and holding the restore open on it would turn every
   * restore into a hang. `nohup` + `&` inside a subshell so the process
   * survives the exec channel closing, and output goes to a log inside the
   * sandbox where it can be read afterwards.
   *
   * Best-effort: a sandbox whose service fails to start is still a working
   * sandbox. The failure surfaces where it is actionable — the waiting page
   * reports that nothing is listening, rather than the restore erroring out.
   */
  private async runStartCommand(
    sandbox: RuntimeSandbox,
    snapshot: SnapshotDocument,
    sandboxId: string,
  ): Promise<void> {
    const command = snapshot.startCommand?.trim();
    if (!command) return;

    // Launching detached means the shell reports success no matter what the
    // command then does, so a command that cannot work is invisible here. Say
    // so at the one moment the logs tie it to a specific restore.
    for (const w of validateStartCommand(command)) {
      this.logger.warn(
        `Start command for snapshot ${snapshot.snapshotId} looks broken ` +
          `(${w.code}): ${w.message}`,
      );
    }

    const log = '/tmp/.devic-start.log';
    const script =
      `( nohup sh -c ${sh(command)} </dev/null >${log} 2>&1 & ) ; echo started`;

    try {
      const res = await sandbox.exec(script);
      if (res.code !== 0) {
        this.logger.warn(
          `Start command for ${sandboxId} (snapshot ${snapshot.snapshotId}) ` +
            `exited ${res.code}: ${res.stderr || res.stdout}`,
        );
        return;
      }
      this.logger.log(
        `Start command launched in ${sandboxId} (snapshot ${snapshot.snapshotId})`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not launch the start command in ${sandboxId}: ${(err as Error).message}`,
      );
    }
  }

  /** Restore a workdir-only snapshot (legacy path): extract tar.gz into workdir. */
  private async restoreWorkdir(
    sandbox: RuntimeSandbox,
    workdir: string,
    sandboxId: string,
    onDiskPath: string,
  ): Promise<void> {
    const guestTarPath = `${workdir}/.devic-runtime-restore-${sandboxId}.tar.gz`;
    await sandbox.copyFromHost(onDiskPath, guestTarPath);

    const extractResult = await sandbox.exec(
      `tar xzf ${guestTarPath} -C ${workdir} && rm -f ${guestTarPath}`,
    );
    if (extractResult.code !== 0) {
      this.logger.warn(
        `Snapshot restore extraction warning: ${extractResult.stderr}`,
      );
    }
  }

  /**
   * Restore a full snapshot into the fresh (base-image) sandbox: extract the
   * diff at `/` preserving perms, then replay deletes. For gzip the compressed
   * artifact is pushed straight in and extracted with `tar -xzpf` (gzip is
   * universal). For zstd the host decompresses to a plain tar first, so the
   * base image never needs a zstd binary. `rm -rf` of deletes is guarded to
   * concrete absolute paths.
   */
  private async restoreFull(
    sandbox: RuntimeSandbox,
    workdir: string,
    sandboxId: string,
    onDiskPath: string,
    codec: Codec,
    deletes: string[],
  ): Promise<void> {
    const safe = (deletes ?? []).filter(isSafeDeletePath);
    const delListPath = `${workdir}/.devic-runtime-deletes-${sandboxId}`;
    const deletesCmd = safe.length
      ? `if [ -f ${sh(delListPath)} ]; then while IFS= read -r p; do case "$p" in /|"") ;; *) rm -rf "$p";; esac; done < ${sh(delListPath)}; rm -f ${sh(delListPath)}; fi`
      : ':';

    const runExtract = async (guestTarPath: string, tarFlags: string) => {
      if (safe.length) {
        await sandbox.writeFile(
          delListPath,
          Buffer.from(safe.join('\n') + '\n', 'utf-8'),
        );
      }
      const script = [
        'set -u',
        'cd / || exit 90',
        `T=${sh(guestTarPath)}`,
        `tar ${tarFlags} "$T"; rc=$?`,
        `rm -f "$T"`,
        `if [ "$rc" -ge 2 ]; then echo "extract rc=$rc" >&2; fi`,
        deletesCmd,
        'echo OK',
      ].join('\n');
      const res = await sandbox.exec(script);
      if (res.code >= 2) {
        this.logger.warn(
          `Full snapshot restore extraction warning: ${res.stderr}`,
        );
      }
    };

    if (codec === 'gzip') {
      // Push the compressed artifact straight in; gzip extract is universal.
      const guestGz = `${workdir}/.devic-runtime-restore-${sandboxId}.tar.gz`;
      await sandbox.copyFromHost(onDiskPath, guestGz);
      await runExtract(guestGz, '-xzpf');
      return;
    }

    // zstd: decompress host-side to a plain tar, then push + extract plain.
    const rawHost = `${onDiskPath}.restoretar`;
    try {
      await this.decompressFile(onDiskPath, rawHost, codec);
      const guestTarPath = `${workdir}/.devic-runtime-restore-${sandboxId}.tar`;
      await sandbox.copyFromHost(rawHost, guestTarPath);
      await runExtract(guestTarPath, '-xpf');
    } finally {
      try {
        unlinkSync(rawHost);
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Host-side (de)compression — streamed so large diffs don't block or buffer.
  // ---------------------------------------------------------------------------

  private async compressFile(
    srcTar: string,
    destPath: string,
    codec: Codec,
  ): Promise<void> {
    // Node's zstd is single-threaded. The CLI with -T0 uses every core, and on
    // a 1.13 GB tar that was 6.7 s against ~12 s — and 16 s all-in against the
    // 83.8 s the inline gzip takes for the same content, at a BETTER ratio
    // (373 MB vs 398 MB). Worth shelling out for; falls back when absent.
    if (codec === 'zstd' && (await hasZstdCli())) {
      await execFileAsync(
        'zstd',
        ['-q', '-f', `-${ZSTD_LEVEL}`, '-T0', srcTar, '-o', destPath],
        { maxBuffer: 1024 * 1024 },
      );
      return;
    }
    const transform =
      codec === 'zstd'
        ? (zlib as any).createZstdCompress({
            params: {
              [(zlib as any).constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
            },
          })
        : zlib.createGzip({ level: GZIP_LEVEL });
    await pipeline(
      createReadStream(srcTar),
      transform,
      createWriteStream(destPath),
    );
  }

  private async decompressFile(
    srcPath: string,
    destTar: string,
    codec: Codec,
  ): Promise<void> {
    const transform =
      codec === 'zstd'
        ? (zlib as any).createZstdDecompress()
        : zlib.createGunzip();
    await pipeline(
      createReadStream(srcPath),
      transform,
      createWriteStream(destTar),
    );
  }

  /** Trim a delete list to the persisted cap, warning when truncated. */
  private capDeletes(deletes: string[]): string[] {
    if (deletes.length <= MAX_PERSISTED_DELETES) return deletes;
    this.logger.warn(
      `Snapshot has ${deletes.length} deletes; persisting only the first ${MAX_PERSISTED_DELETES}`,
    );
    return deletes.slice(0, MAX_PERSISTED_DELETES);
  }

  private async findSandbox(
    id: string,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const doc =
      (await this.sandboxRepo.findOne({ sandboxId: id } as any, scope)) ??
      (await this.sandboxRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Sandbox ${id} not found`);
    return doc;
  }

  private async getSandboxInstance(doc: SandboxDocument): Promise<RuntimeSandbox> {
    const containerName = await this.registry.get(doc.sandboxId);
    const name = containerName ?? doc.name;

    const handle = await this.runtime.get(name);
    if (!handle) {
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: not found`,
      );
    }

    try {
      if (handle.status === 'running') return handle.connect();
      return handle.start();
    } catch (err) {
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: ${(err as Error).message}`,
      );
    }
  }
}
