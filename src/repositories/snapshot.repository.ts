import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { Snapshot, SnapshotDocument } from '../schemas/snapshot.schema';
import { ExtensionScope } from '../interfaces';

@Injectable()
export class SnapshotRepository extends BaseRepository<SnapshotDocument> {
  constructor(
    @InjectModel(Snapshot.name)
    private readonly snapshotModel: Model<SnapshotDocument>,
    @Inject(EXTENSIONS_TOKEN) extensions: ExtensionProperty[],
  ) {
    super(snapshotModel, 'Snapshot', extensions);
  }

  async findBySandboxId(
    sandboxId: string,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument[]> {
    const results = await this.model
      .find(this.applyScope({ sandboxId } as any, scope))
      .sort({ createdAt: -1 })
      .exec();
    return results as SnapshotDocument[];
  }

  /**
   * The snapshot served under a public subdomain, or null.
   *
   * Deliberately UNSCOPED: the caller is the ingress proxy resolving a hostname
   * that arrived from the internet, where there is no tenant to scope by. The
   * subdomain is the whole authorisation story here — the same as today, where
   * anyone with the hostname reaches the sandbox behind it.
   *
   * Two lookups because a snapshot's label has two possible sources:
   *  1. an explicit `slug`, indexed and unique — the fast, normal path;
   *  2. otherwise one derived from `snapshotId` via `toDnsLabel`, which is
   *     lossy (lowercased, `_`→`-`). It cannot be indexed, so it is recovered
   *     by matching the id case-insensitively with each `-` allowed to stand
   *     for either character. This only runs for snapshots with no slug, and
   *     only on the dormant path — a live sandbox is answered from Redis and
   *     never reaches here.
   */
  async findBySubdomain(subdomain: string): Promise<SnapshotDocument | null> {
    const sub = subdomain.toLowerCase();

    const bySlug = await this.model.findOne({ slug: sub } as any).exec();
    if (bySlug) return bySlug as SnapshotDocument;

    // Escape regex metacharacters, then let '-' match the '_' it replaced.
    const pattern = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-_]');
    const byId = await this.model
      .findOne({
        slug: { $in: [null, undefined] },
        snapshotId: { $regex: `^${pattern}$`, $options: 'i' },
      } as any)
      .exec();
    return (byId as SnapshotDocument) ?? null;
  }
}
