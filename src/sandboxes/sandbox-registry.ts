import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';

const REGISTRY_PREFIX = 'sandbox:registry:';

@Injectable()
export class SandboxRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxRegistry.name);
  private readonly redis: Redis;

  constructor(@Inject(CONFIG) private readonly config: ModuleConfig) {
    this.redis = new Redis(config.redis.url);
    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async register(sandboxId: string, containerName: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      `${REGISTRY_PREFIX}${sandboxId}`,
      containerName,
      'EX',
      ttlSeconds + 60,
    );
  }

  async get(sandboxId: string): Promise<string | null> {
    return this.redis.get(`${REGISTRY_PREFIX}${sandboxId}`);
  }

  async remove(sandboxId: string): Promise<void> {
    await this.redis.del(`${REGISTRY_PREFIX}${sandboxId}`);
  }

  async has(sandboxId: string): Promise<boolean> {
    const exists = await this.redis.exists(`${REGISTRY_PREFIX}${sandboxId}`);
    return exists === 1;
  }

  async extendTtl(sandboxId: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(`${REGISTRY_PREFIX}${sandboxId}`, ttlSeconds + 60);
  }

  getRedisClient(): Redis {
    return this.redis;
  }
}
