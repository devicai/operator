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
/** How often orphaned images are collected and the cache reconciled with its cap. */
const SWEEP_INTERVAL_MS = 300_000;

export type ApplyTarball = (
  containerName: string,
  snapshot: SnapshotDocument,
) => Promise<void>;

/**
 * Rebuild the snapshot's tarball from its current image. Registered by
 * SnapshotsService, which owns the capture machinery.
 *
 * Resolves to the refreshed document, or null when it could not be produced.
 */
export type RefreshTarball = (
  snapshot: SnapshotDocument,
) => Promise<SnapshotDocument | null>;

const DEFAULT_CONSOLIDATE_AT_LAYERS = 40;
const DEFAULT_CONSOLIDATE_AT_TARBALL_LAG = 5;
/**
 * Layer count at which an image stops being startable. Measured under
 * sysbox-runc; `docker.runtime-provider` refuses to publish at or above it.
 * Kept in step with MAX_IMAGE_LAYERS there.
 */
const RUNTIME_LAYER_CEILING = 70;
/** Headroom kept below the ceiling so a save always has somewhere to go. */
const LAYER_SAFETY_MARGIN = 5;

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

  /** Rebuilds a snapshot's tarball from its image. Injected for the same reason. */
  private refreshTarball: RefreshTarball | null = null;

  /** snapshotIds with a consolidation running, so two never overlap. */
  private readonly consolidating = new Set<string>();

  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {}

  registerTarballApplier(fn: ApplyTarball): void {
    this.applyTarball = fn;
  }

  registerTarballRefresher(fn: RefreshTarball): void {
    this.refreshTarball = fn;
  }

  // ---------------------------------------------------------------------------
  // Commit-based saves and consolidation
  // ---------------------------------------------------------------------------

  /**
   * Whether a save may seal the sandbox's writable layer instead of walking it.
   * Needs the cache on, the opt-in set, and a runtime that can commit.
   */
  canCommitLive(): boolean {
    return (
      this.isEnabled() &&
      this.config.snapshots?.imageCache?.commitLive === true &&
      !!this.runtime.commitImage
    );
  }

  private get consolidateAtLayers(): number {
    const v = this.config.snapshots?.imageCache?.consolidateAtLayers;
    return v && v > 0 ? v : DEFAULT_CONSOLIDATE_AT_LAYERS;
  }

  private get consolidateAtTarballLag(): number {
    const v = this.config.snapshots?.imageCache?.consolidateAtTarballLag;
    return v && v > 0 ? v : DEFAULT_CONSOLIDATE_AT_TARBALL_LAG;
  }

  /**
   * True when another commit would risk producing an image the runtime cannot
   * start. The caller saves via the tarball instead and asks for consolidation.
   *
   * Layers stack once per SESSION, not per save — a second save inside one
   * session replaces the top layer rather than adding to it — so this is
   * reached slowly, if ever.
   */
  isOutOfLayerHeadroom(snapshot: SnapshotDocument): boolean {
    const layers = snapshot.imageLayers ?? 0;
    return layers > 0 && layers >= RUNTIME_LAYER_CEILING - LAYER_SAFETY_MARGIN;
  }

  /** Whether this snapshot's tarball is behind the image, and by how much. */
  tarballLag(snapshot: SnapshotDocument): number {
    return (snapshot.persistVersion ?? 0) - (snapshot.tarballVersion ?? 0);
  }

  private needsConsolidation(snapshot: SnapshotDocument): boolean {
    return (
      (snapshot.imageLayers ?? 0) >= this.consolidateAtLayers ||
      this.isOutOfLayerHeadroom(snapshot)
    );
  }

  /**
   * Background work owed after a commit-based save: refresh the tarball, and
   * flatten back to base+1 once the stack has grown enough.
   *
   * Fire-and-forget by design. The caller has already been told the save
   * succeeded, and it did — the image holds the content. What is outstanding is
   * durability (the tarball is what survives the daemon, backups and migration)
   * and layer headroom, and neither is worth making a stop wait for.
   */
  scheduleConsolidation(snapshot: SnapshotDocument): void {
    if (!this.isEnabled()) return;
    void this.consolidate(snapshot).catch((err) => {
      this.logger.warn(
        `Consolidation for snapshot ${snapshot.snapshotId} failed: ${(err as Error).message}`,
      );
    });
  }

  async consolidate(snapshot: SnapshotDocument): Promise<void> {
    const snapshotId = snapshot.snapshotId;
    if (this.consolidating.has(snapshotId)) {
      this.logger.debug(`Consolidation for ${snapshotId} already in flight`);
      return;
    }
    this.consolidating.add(snapshotId);

    try {
      let current = snapshot;

      const lag = this.tarballLag(current);
      if (lag > 0 && this.refreshTarball) {
        if (lag >= this.consolidateAtTarballLag) {
          this.logger.warn(
            `Snapshot ${snapshotId} tarball is ${lag} versions behind; the ` +
              'image has been the only fresh copy for that long',
          );
        }
        const refreshed = await this.refreshTarball(current);
        if (!refreshed) {
          this.logger.warn(
            `Could not refresh the tarball of ${snapshotId}; it stays ${lag} ` +
              'version(s) behind and the image remains the only fresh copy',
          );
          return;
        }
        current = refreshed;
      }

      // Only now, with a tarball that matches the image, is flattening safe:
      // the rebuild replays that tarball onto the original base.
      if (this.needsConsolidation(current)) {
        this.logger.log(
          `Consolidating snapshot ${snapshotId}: ${current.imageLayers} layers ` +
            `after ${current.imageGeneration ?? 0} generation(s)`,
        );
        await this.build(current, { keepUsable: true });
      }
    } finally {
      this.consolidating.delete(snapshotId);
    }
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        'Snapshot image cache is off — restores replay the tarball',
      );
      return;
    }
    // Collect garbage first, then trade off what is left against the cap: an
    // image with no snapshot must never cost a live one its place.
    this.sweepTimer = setInterval(() => {
      void this.reclaimOrphans().then(() => this.enforceCap());
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

  async build(
    snapshot: SnapshotDocument,
    opts: { keepUsable?: boolean } = {},
  ): Promise<void> {
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

    // A consolidation replaces a working image with an equivalent one that is
    // merely shallower, so announcing 'building' would send every restore down
    // the tarball path for no reason. The tag flips atomically at the commit.
    if (!opts.keepUsable) await this.setState(docId, 'building');

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
        // `ref` is the live tag. When a commit-based save published it for the
        // newer version, dropping it here would delete the only fresh copy —
        // so only the pre-commit flow, where the tag still points at content
        // nobody wants, may clear it.
        if (!opts.keepUsable) {
          await this.runtime.removeImage?.(ref).catch(() => undefined);
          await this.setState(docId, 'none');
        }
        return;
      }

      const info = await this.runtime.commitImage!(helper, ref, {
        labels: { 'devic-sandbox.snapshot': snapshotId },
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
            // Built from the base image plus the tarball, so the stack is back
            // to base+1 and the generation count starts over.
            imageLayers: info.layers,
            imageGeneration: 0,
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
      // Committing over the tag just orphaned the previous image for this
      // snapshot. Collect it here, where it is created: a snapshot saved every
      // few minutes would otherwise pile up a full rootfs per save.
      await this.pruneSuperseded(snapshotId).catch(() => undefined);
      if (this.maxTotalBytes) {
        await this.enforceCap().catch(() => undefined);
      }
    }
  }

  /**
   * Remove images left untagged by a newer commit for the same snapshot.
   *
   * These are dead by construction: `refFor` gives every snapshot ONE tag, so
   * the moment a rebuild commits over it, the previous image can no longer be
   * resolved by any restore. They are not cache to trade against the cap —
   * they are garbage, and unlike the cap path this never clears the snapshot's
   * bookkeeping, because the tag it names now belongs to the live image.
   *
   * @param snapshotId when given, only that snapshot's leftovers are swept.
   */
  private async pruneSuperseded(snapshotId?: string): Promise<number> {
    if (!this.runtime.listSnapshotImages || !this.runtime.removeImage) return 0;
    const images = await this.runtime.listSnapshotImages(this.repository);
    const stale = images.filter(
      (i) => i.superseded && !i.inUse && (!snapshotId || i.tag === snapshotId),
    );
    let freed = 0;
    let dropped = 0;
    for (const img of stale) {
      if (!(await this.runtime.removeImage(img.ref))) continue;
      freed += img.uniqueSizeBytes;
      dropped++;
    }
    if (dropped) {
      this.logger.log(
        `Dropped ${dropped} superseded snapshot image(s)` +
          (snapshotId ? ` for ${snapshotId}` : '') +
          `, freeing ${fmt(freed)}`,
      );
    }
    return freed;
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
   * Drop images whose snapshot no longer exists.
   *
   * `destroy()` already asks for this, but the daemon refuses to remove an
   * image while ANY container still references it — a stopped one counts — so
   * deleting a snapshot whose sandboxes are still around always leaves its
   * image behind. Once those containers go, nothing can ever restore from it:
   * a restore reads the snapshot document, and that is gone.
   *
   * So this is not cache to be traded against the cap, it is garbage, and it is
   * collected unconditionally. Leaving it to `enforceCap` means it survives
   * until the cache is under pressure — and with `maxTotalBytes` unset, which
   * the config allows, it means forever.
   */
  async reclaimOrphans(): Promise<void> {
    if (
      !this.isEnabled() ||
      !this.runtime.listSnapshotImages ||
      !this.runtime.removeImage
    ) {
      return;
    }

    try {
      // Superseded leftovers first: they belong to snapshots that are very
      // much alive, so the "snapshot is gone" rule below would never reach
      // them. build() already sweeps them per snapshot; this covers whatever
      // was orphaned before this sweeper existed, or while it was held.
      await this.pruneSuperseded().catch(() => undefined);

      const images = await this.runtime.listSnapshotImages(this.repository);
      // An image still held by a container cannot be removed anyway, and the
      // holder may be a sandbox that is about to be reclaimed — try again next
      // sweep rather than logging a failure every five minutes.
      const free = images.filter((i) => !i.inUse && !i.superseded);
      if (!free.length) return;

      // The tag IS the snapshotId (see refFor), so one query answers the whole
      // batch instead of one lookup per image.
      const tags = free.map((i) => i.tag);
      const known = await this.snapshotRepo.find(
        { snapshotId: { $in: tags } } as any,
        {},
        { limit: tags.length },
      );
      const alive = new Set((known.data ?? []).map((d) => d.snapshotId));

      let dropped = 0;
      let freed = 0;
      for (const img of free) {
        if (alive.has(img.tag)) continue;
        if (!(await this.runtime.removeImage!(img.ref))) continue;
        dropped++;
        freed += img.uniqueSizeBytes;
      }

      if (dropped) {
        this.logger.log(
          `Reclaimed ${dropped} snapshot image(s) whose snapshot is gone, ` +
            `freeing ${fmt(freed)}`,
        );
      }
    } catch (err) {
      // Same contract as the rest of this service: never let cache maintenance
      // take anything down.
      this.logger.warn(
        `Orphan image reclaim failed: ${(err as Error).message}`,
      );
    }
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
      // Reclaim the free garbage before evicting anything anyone still uses.
      await this.pruneSuperseded().catch(() => undefined);

      const images = (
        await this.runtime.listSnapshotImages(this.repository)
      ).filter((i) => !i.superseded);
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
