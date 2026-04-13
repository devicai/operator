import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Sandbox as MsbSandbox } from 'microsandbox';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from './sandbox-registry';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';

@Injectable()
export class SandboxTtlService {
  private readonly logger = new Logger(SandboxTtlService.name);
  private running = false;

  constructor(
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
  ) {}

  @Interval(30000)
  async checkExpiredSandboxes(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const expired = await this.sandboxRepo.findExpired();
      if (expired.length === 0) return;

      this.logger.log(`Found ${expired.length} expired sandbox(es)`);

      for (const doc of expired) {
        const claimed = await this.sandboxRepo.atomicExpire(
          (doc as any)._id.toString(),
        );
        if (!claimed) continue;

        // Persist filesystem state to linked snapshot before detaching
        if (doc.snapshotId) {
          await this.snapshotsService.persistToSnapshot(doc);
        }

        try {
          const containerName = await this.registry.get(doc.sandboxId);
          if (containerName) {
            const handle = await MsbSandbox.get(containerName);
            const sandbox = await handle.connect();
            await sandbox.detach();
          }
        } catch (err) {
          this.logger.warn(
            `Error detaching expired sandbox ${doc.sandboxId}: ${(err as Error).message}`,
          );
        }

        await this.registry.remove(doc.sandboxId);
        this.logger.log(`Sandbox ${doc.sandboxId} expired and detached`);
      }
    } catch (err) {
      this.logger.error(`TTL check error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
