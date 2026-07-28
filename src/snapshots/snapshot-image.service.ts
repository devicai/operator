import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SnapshotDocument } from '../schemas/snapshot.schema';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';

const DEFAULT_REPOSITORY = 'devic-snapshot';
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
/** How often the cache is reconciled against its cap. */
const SWEEP_INTERVAL_MS = 300_000;

export type ApplyTarball = (
  containerName: string,
  snapshot: SnapshotDocument,
) => Promise<void>;

/**
 * Keeps a per-snapshot container image alongside each snapshot's tarball, so a
 * restore is "create a container" rather than "create a container and replay a
 * tarball into it" — measured ~2s flat against 15-65s scaling with size.
 *
 * Two rules define this service, and both matter more than the speed:
 *
 * 1. The image is ALWAYS built from the snapshot's ORIGINAL base image plus its
 *    tarball — never by committing a sandbox that was itself restored from a
 *    snapshot image. Committing on top of a previous image would add one layer
 *    per persist, and under sysbox-runc an image of 71 layers stops being
 *    startable (70 works; measured). Rebuilding from the base pins depth at
 *    base+1 forever, so that ceiling is unreachable rather than merely
 *    monitored. It also keeps the image byte-identical in content to the
 *    tarball, which a direct commit would not be: a commit takes everything,
 *    while the tarball honours `snapshots.cleanup` exclusions.
 *
 * 2. The image is a cache and never the only copy. Every failure here is
 *    logged and swallowed: the snapshot stays restorable from its tarball,
 *    which is exactly the behaviour that predates this service.
 */
@Injectable()
export class SnapshotImageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SnapshotImageService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  /** snapshotId of builds in flight, so a second capture cannot race a first. */
  private readonly building = new Set<string>();

  /**
   * Applies a snapshot's tarball into a freshly created container. Injected by
   * SnapshotsService at module init to avoid a circular dependency — the
   * extraction logic (codec handling, delete replay) lives there and is shared
   * verbatim with the restore path, so the image can never be built by a
   * different procedure than the one it replaces.
   */
  private applyTarball: ApplyTarball | null = null;

  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {}

  registerTarballApplier(fn: ApplyTarball): void {
    this.applyTarball = fn;
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        'Snapshot image cache is off — restores replay the tarball',
      );
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.enforceCap();
    }, SWEEP_INTERVAL_MS);
    this.logger.log(
      `Snapshot image cache on (repository=${this.repository}, ` +
        `cap=${this.maxTotalBytes ? fmt(this.maxTotalBytes) : 'none'})`,
    );
    if (!this.maxTotalBytes) {
      this.logger.warn(
        'snapshots.imageCache.maxTotalBytes is not set: cached images will ' +
          'grow until the disk is full. Set a cap.',
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  isEnabled(): boolean {
    return (
      this.config.snapshots?.imageCache?.enabled === true &&
      !!this.runtime.commitImage &&
      !!this.runtime.imageExists
    );
  }

  private get repository(): string {
    return (
      this.config.snapshots?.imageCache?.repository?.trim() ||
      DEFAULT_REPOSITORY
    );
  }

  private get maxTotalBytes(): number | undefined {
    const v = this.config.snapshots?.imageCache?.maxTotalBytes;
    return v && v > 0 ? v : undefined;
  }

  private get buildTimeoutMs(): number {
    const v = this.config.snapshots?.imageCache?.buildTimeoutMs;
    return v && v > 0 ? v : DEFAULT_BUILD_TIMEOUT_MS;
  }

  refFor(snapshotId: string): string {
    return `${this.repository}:${snapshotId}`;
  }

  /**
   * Whether a restore may be served from `snapshot`'s image.
   *
   * Deliberately strict: the recorded build must match the snapshot's current
   * version (a stale image would serve content the tarball no longer holds)
   * AND the image must still be on the daemon (it may have been evicted, or
   * pruned out of band). Anything short of both means fall back to the tarball.
   */
  async isUsable(snapshot: SnapshotDocument): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (snapshot.imageState !== 'ready' || !snapshot.imageRef) return false;
    if ((snapshot.imageSourceVersion ?? -1) !== (snapshot.persistVersion ?? 0)) {
      return false;
    }
    return this.runtime.imageExists!(snapshot.imageRef).catch(() => false);
  }

  /** Record that a restore was served from the image, for LRU ordering. */
  async markUsed(snapshot: SnapshotDocument): Promise<void> {
    await this.snapshotRepo
      .updateById(
        (snapshot as any)._id.toString(),
        { $set: { imageLastUsedAt: new Date() } },
        {},
      )
      .catch(() => undefined);
  }

  /**
   * Build (or rebuild) the image for a snapshot. Fire-and-forget: callers
   * invoke this after a capture and do not await it, so a slow build never
   * delays a stop or a snapshot create.
   */
  scheduleBuild(snapshot: SnapshotDocument): void {
    if (!this.isEnabled()) return;
    void this.build(snapshot).catch((err) => {
      this.logger.warn(
        `Image build for snapshot ${snapshot.snapshotId} failed: ${(err as Error).message}`,
      );
    });
  }

  async build(snapshot: SnapshotDocument): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.applyTarball) {
      this.logger.warn('No tarball applier registered; skipping image build');
      return;
    }
    const snapshotId = snapshot.snapshotId;
    if (this.building.has(snapshotId)) {
      this.logger.debug(`Image build for ${snapshotId} already in flight`);
      return;
    }
    this.building.add(snapshotId);

    // The version this build is for. If a newer capture lands while we work,
    // the result describes content nobody wants and is thrown away.
    const builtVersion = snapshot.persistVersion ?? 0;
    const ref = this.refFor(snapshotId);
    const helper = `snapimg-${nanoid(10)}`;
    const docId = (snapshot as any)._id.toString();

    await this.setState(docId, 'building');

    const started = Date.now();
    try {
      await withTimeout(
        this.materializeInto(snapshot, helper),
        this.buildTimeoutMs,
        `image build for ${snapshotId}`,
      );

      const current = await this.snapshotRepo.findOne(
        { snapshotId } as any,
        {},
      );
      const currentVersion = current?.persistVersion ?? 0;
      if (currentVersion !== builtVersion) {
        this.logger.log(
          `Discarding image for ${snapshotId}: built from version ` +
            `${builtVersion}, snapshot is now at ${currentVersion}`,
        );
        await this.runtime.removeImage?.(ref).catch(() => undefined);
        await this.setState(docId, 'none');
        return;
      }

      const info = await this.runtime.commitImage!(helper, ref, {
        'devic-sandbox.snapshot': snapshotId,
      });

      await this.snapshotRepo.updateById(
        docId,
        {
          $set: {
            imageState: 'ready',
            imageRef: info.ref,
            imageSourceVersion: builtVersion,
            imageBuiltAt: new Date(),
            imageSizeBytes: info.uniqueSizeBytes,
          },
        },
        {},
      );
      this.logger.log(
        `Snapshot ${snapshotId} image ready: ${info.ref} ` +
          `(${fmt(info.uniqueSizeBytes)}, ${info.layers} layers, ` +
          `${Math.round((Date.now() - started) / 1000)}s)`,
      );
    } catch (err) {
      await this.setState(docId, 'failed');
      this.logger.warn(
        `Image build for snapshot ${snapshotId} failed, restores will use the ` +
          `tarball: ${(err as Error).message}`,
      );
    } finally {
      this.building.delete(snapshotId);
      await this.runtime.remove(helper).catch(() => undefined);
      if (this.maxTotalBytes) {
        await this.enforceCap().catch(() => undefined);
      }
    }
  }

  /**
   * Materialize the snapshot into a throwaway container built on the ORIGINAL
   * base image, so the resulting commit is always base+1 layers. See the class
   * comment for why this must never start from a previous snapshot image.
   */
  private async materializeInto(
    snapshot: SnapshotDocument,
    helper: string,
  ): Promise<void> {
    await this.runtime.create({
      name: helper,
      image: snapshot.image,
      workdir: snapshot.workdir,
      cpus: snapshot.cpus,
      memoryMib: snapshot.memoryMib,
      env: snapshot.envVars ?? {},
      // No ports and no ingress: this container exists only to be committed.
      networkPolicy: 'deny-all',
    });
    await this.applyTarball!(helper, snapshot);
    // The commit itself happens in build(), after re-reading the version, so a
    // build that was superseded mid-flight never publishes a tag.
  }

  /**
   * Drop least-recently-used images until the cache fits its cap.
   *
   * Ordering comes from the database (`imageLastUsedAt`, falling back to build
   * time) rather than from the daemon, because "least recently restored" is the
   * signal that matters and Docker only knows when an image was created.
   */
  async enforceCap(): Promise<void> {
    const cap = this.maxTotalBytes;
    if (!this.isEnabled() || !cap || !this.runtime.listSnapshotImages) return;

    try {
      const images = await this.runtime.listSnapshotImages(this.repository);
      const total = images.reduce((s, i) => s + i.uniqueSizeBytes, 0);
      if (total <= cap) return;

      const docs = await this.snapshotRepo.find(
        { imageState: 'ready' } as any,
        {},
        { limit: 1000 },
      );
      const lastUsed = new Map<string, number>();
      for (const d of docs.data ?? []) {
        const t =
          (d.imageLastUsedAt ? new Date(d.imageLastUsedAt).getTime() : 0) ||
          (d.imageBuiltAt ? new Date(d.imageBuiltAt).getTime() : 0);
        lastUsed.set(d.snapshotId, t);
      }

      const candidates = images
        .filter((i) => !i.inUse)
        .sort(
          (a, b) => (lastUsed.get(a.tag) ?? 0) - (lastUsed.get(b.tag) ?? 0),
        );

      let freed = 0;
      let dropped = 0;
      for (const img of candidates) {
        if (total - freed <= cap) break;
        const ok = await this.runtime.removeImage!(img.ref);
        if (!ok) continue;
        freed += img.uniqueSizeBytes;
        dropped++;
        await this.forgetImage(img.tag);
      }

      const held = images.length - candidates.length;
      this.logger.log(
        `Snapshot image cache over cap (${fmt(total)} > ${fmt(cap)}): ` +
          `evicted ${dropped}, freed ${fmt(freed)}` +
          (held > 0 ? `, ${held} in use and kept` : ''),
      );
      if (total - freed > cap) {
        this.logger.warn(
          `Snapshot image cache still over cap at ${fmt(total - freed)}: ` +
            'nothing further is evictable right now',
        );
      }
    } catch (err) {
      this.logger.warn(`Image cache sweep failed: ${(err as Error).message}`);
    }
  }

  /** Drop a snapshot's image and clear its bookkeeping. Used by destroy(). */
  async discard(snapshot: SnapshotDocument): Promise<void> {
    if (!this.runtime.removeImage) return;
    const ref = snapshot.imageRef || this.refFor(snapshot.snapshotId);
    await this.runtime.removeImage(ref).catch(() => undefined);
  }

  private async forgetImage(snapshotId: string): Promise<void> {
    const doc = await this.snapshotRepo
      .findOne({ snapshotId } as any, {})
      .catch(() => null);
    if (!doc) return;
    await this.snapshotRepo
      .updateById(
        (doc as any)._id.toString(),
        {
          $set: { imageState: 'none' },
          $unset: { imageRef: '', imageSourceVersion: '', imageSizeBytes: '' },
        },
        {},
      )
      .catch(() => undefined);
  }

  private async setState(docId: string, state: string): Promise<void> {
    await this.snapshotRepo
      .updateById(docId, { $set: { imageState: state } }, {})
      .catch(() => undefined);
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
