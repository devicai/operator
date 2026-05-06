import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Sandbox as MsbSandbox, Patch } from 'microsandbox';
import type { SandboxConfig } from 'microsandbox';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import { SnapshotDocument, SnapshotStatus } from '../schemas/snapshot.schema';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ResourceUsageService } from '../providers/resource-usage.service';

const SNAPSHOTS_DIR = join(homedir(), '.microsandbox', 'snapshots');

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly resourceUsage: ResourceUsageService,
  ) {
    if (!existsSync(SNAPSHOTS_DIR)) {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  }

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
    const snapshotId = nanoid(12);
    const snapshotFileName = `${snapshotId}.tar.gz`;
    const snapshotPath = join(SNAPSHOTS_DIR, snapshotFileName);
    const guestTarPath = `/tmp/snapshot-${snapshotId}.tar.gz`;

    const doc = await this.snapshotRepo.create(
      {
        snapshotId,
        sandboxId: sandboxDoc.sandboxId,
        name: dto.name || `snapshot-${snapshotId}`,
        description: dto.description || '',
        status: SnapshotStatus.CREATING,
        image: sandboxDoc.image,
        workdir: sandboxDoc.workdir,
        cpus: sandboxDoc.cpus,
        memoryMib: sandboxDoc.memoryMib,
        envVars: sandboxDoc.envVars ?? {},
        ports: sandboxDoc.ports ?? {},
        snapshotPath,
        sizeBytes: 0,
        metadata: {
          sourceSandboxName: sandboxDoc.name,
          currentCwd: sandboxDoc.currentCwd,
        },
      } as any,
      scope,
    );

    try {
      this.logger.log(
        `Creating snapshot ${snapshotId} from sandbox ${sandboxDoc.sandboxId}...`,
      );

      const tarResult = await sandbox.shell(
        `tar czf ${guestTarPath} -C ${sandboxDoc.workdir} .`,
      );

      if (tarResult.code !== 0) {
        throw new Error(`tar failed: ${tarResult.stderr()}`);
      }

      const fs = sandbox.fs();
      await fs.copyToHost(guestTarPath, snapshotPath);

      // Clean up tar inside sandbox
      await sandbox.shell(`rm -f ${guestTarPath}`);

      let sizeBytes = 0;
      try {
        sizeBytes = statSync(snapshotPath).size;
      } catch {}

      const updated = await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        {
          $set: {
            status: SnapshotStatus.READY,
            sizeBytes,
          },
        },
        scope,
      );

      this.logger.log(
        `Snapshot ${snapshotId} created (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );

      return updated!;
    } catch (err) {
      await this.snapshotRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SnapshotStatus.FAILED } },
        scope,
      );
      this.logger.error(
        `Snapshot ${snapshotId} failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async restore(
    snapshotId: string,
    dto: RestoreSnapshotDto,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const snapshot = await this.findById(snapshotId, scope);
    if (snapshot.status !== SnapshotStatus.READY) {
      throw new BadRequestException(
        `Snapshot is not ready (status: ${snapshot.status})`,
      );
    }

    if (!existsSync(snapshot.snapshotPath)) {
      throw new BadRequestException('Snapshot file not found on disk');
    }

    const defaults = this.config.microsandbox;
    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const restoreMemoryMib = dto.memoryMib ?? snapshot.memoryMib;

    await this.resourceUsage.assertMemoryAvailable(restoreMemoryMib);

    const isLinked = dto.linked !== false; // default true

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
        ports: snapshot.ports ?? {},
        ttlSeconds,
        expiresAt,
        ...(isLinked ? { snapshotId: snapshot.snapshotId } : {}),
        commandCount: 0,
        recentCommands: [],
        metadata: {
          restoredFrom: snapshot.snapshotId,
          restoredAt: new Date().toISOString(),
          linked: isLinked,
        },
      } as any,
      scope,
    );

    try {
      const msbConfig: SandboxConfig = {
        name: containerName,
        image: snapshot.image,
        workdir: snapshot.workdir,
        cpus: dto.cpus ?? snapshot.cpus,
        memoryMib: dto.memoryMib ?? snapshot.memoryMib,
        env: snapshot.envVars ?? {},
        patches: [Patch.mkdir(snapshot.workdir)],
        network: { policy: 'allow-all' as any, tls: { interceptedPorts: [] } },
        quietLogs: true,
        replace: true,
      };

      if (Object.keys(snapshot.ports ?? {}).length > 0) {
        msbConfig.ports = {};
        for (const [k, v] of Object.entries(snapshot.ports)) {
          msbConfig.ports[k] = v;
        }
      }

      const msbInstance = await MsbSandbox.create(msbConfig);
      await this.registry.register(sandboxId, containerName, ttlSeconds);

      // Restore snapshot: copy tarball into sandbox and extract
      const guestTarPath = `/tmp/restore-${sandboxId}.tar.gz`;
      const fs = msbInstance.fs();
      await fs.copyFromHost(snapshot.snapshotPath, guestTarPath);

      const extractResult = await msbInstance.shell(
        `tar xzf ${guestTarPath} -C ${snapshot.workdir} && rm -f ${guestTarPath}`,
      );

      if (extractResult.code !== 0) {
        this.logger.warn(
          `Snapshot restore extraction warning: ${extractResult.stderr()}`,
        );
      }

      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.RUNNING } },
        scope,
      );

      this.logger.log(
        `Sandbox ${sandboxId} restored from snapshot ${snapshotId}`,
      );

      const updated = await this.sandboxRepo.findById(
        (sandboxDoc as any)._id.toString(),
        scope,
      );
      return updated!;
    } catch (err) {
      await this.sandboxRepo.updateById(
        (sandboxDoc as any)._id.toString(),
        { $set: { status: SandboxStatus.FAILED } },
        scope,
      );
      throw err;
    }
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

  async destroy(id: string, scope: ExtensionScope): Promise<void> {
    const doc = await this.findById(id, scope);

    // Remove file from disk
    try {
      if (existsSync(doc.snapshotPath)) {
        unlinkSync(doc.snapshotPath);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete snapshot file ${doc.snapshotPath}: ${(err as Error).message}`,
      );
    }

    await this.snapshotRepo.deleteById((doc as any)._id.toString(), scope);
    this.logger.log(`Snapshot ${doc.snapshotId} destroyed`);
  }

  /**
   * Persist the current sandbox filesystem state back to its linked snapshot.
   * Called automatically when a snapshot-linked sandbox is stopped or expires.
   */
  async persistToSnapshot(sandboxDoc: SandboxDocument): Promise<void> {
    if (!sandboxDoc.snapshotId) return;

    let snapshotDoc: SnapshotDocument | null;
    try {
      snapshotDoc = await this.snapshotRepo.findOne(
        { snapshotId: sandboxDoc.snapshotId } as any,
        {},
      );
    } catch {
      snapshotDoc = null;
    }

    if (!snapshotDoc || snapshotDoc.status !== SnapshotStatus.READY) {
      this.logger.warn(
        `Snapshot ${sandboxDoc.snapshotId} not found or not ready, skipping persist`,
      );
      return;
    }

    const guestTarPath = `/tmp/persist-${sandboxDoc.sandboxId}.tar.gz`;

    try {
      this.logger.log(
        `Persisting sandbox ${sandboxDoc.sandboxId} to snapshot ${snapshotDoc.snapshotId}...`,
      );

      // Get a fresh connection to the running sandbox
      const containerName =
        (await this.registry.get(sandboxDoc.sandboxId)) ?? sandboxDoc.name;
      const handle: any = await MsbSandbox.get(containerName);
      if (handle.status !== 'running') {
        this.logger.warn(
          `Sandbox ${sandboxDoc.sandboxId} not running (status: ${handle.status}), skipping persist`,
        );
        return;
      }
      const sandbox = await handle.connect();

      const tarResult = await sandbox.shell(
        `tar czf ${guestTarPath} -C ${sandboxDoc.workdir} .`,
      );

      if (tarResult.code !== 0) {
        this.logger.error(`Persist tar failed: ${tarResult.stderr()}`);
        return;
      }

      const fs = sandbox.fs();
      await fs.copyToHost(guestTarPath, snapshotDoc.snapshotPath);
      await sandbox.shell(`rm -f ${guestTarPath}`);

      let sizeBytes = 0;
      try {
        sizeBytes = statSync(snapshotDoc.snapshotPath).size;
      } catch {}

      await this.snapshotRepo.updateById(
        (snapshotDoc as any)._id.toString(),
        {
          $set: {
            sizeBytes,
            'metadata.lastPersistedFrom': sandboxDoc.sandboxId,
            'metadata.lastPersistedAt': new Date().toISOString(),
            'metadata.currentCwd': sandboxDoc.currentCwd,
          },
        },
        {},
      );

      this.logger.log(
        `Snapshot ${snapshotDoc.snapshotId} updated from sandbox ${sandboxDoc.sandboxId} (${(sizeBytes / 1024).toFixed(1)} KB)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist snapshot ${snapshotDoc.snapshotId}: ${(err as Error).message}`,
      );
    }
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

  private async getSandboxInstance(doc: SandboxDocument): Promise<MsbSandbox> {
    const containerName = await this.registry.get(doc.sandboxId);
    const name = containerName ?? doc.name;

    try {
      const handle: any = await MsbSandbox.get(name);
      if (handle.status === 'running') {
        return await handle.connect();
      }
      return await handle.start();
    } catch (err) {
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: ${(err as Error).message}`,
      );
    }
  }
}
