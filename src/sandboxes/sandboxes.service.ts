import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ConflictException, forwardRef, Optional } from '@nestjs/common';
import * as net from 'net';
import { nanoid } from 'nanoid';
import { SandboxRegistry } from './sandbox-registry';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxProfileRepository } from '../repositories/sandbox-profile.repository';
import { SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { RunCommandDto } from './dto/run-command.dto';
import { StopSandboxDto } from './dto/stop-sandbox.dto';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ResourceUsageService } from '../providers/resource-usage.service';
import { HotPoolService } from '../hot-pool/hot-pool.service';
import { IngressService } from '../ingress/ingress.service';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  RuntimeSandbox,
  ShellCommandTimeoutError,
} from '../runtime/runtime-provider.interface';
import { isImageAllowed, sanitizeHostPorts } from '../runtime/admission.util';
import {
  buildListDirScript,
  parseListDirOutput,
  SandboxFileEntry,
} from './sandbox-ls.util';
import { join } from 'path';
import * as posixPath from 'path/posix';
import { tmpdir } from 'os';
import { createReadStream, statSync, existsSync, unlinkSync, rm } from 'fs';
import { Readable } from 'stream';

/**
 * How close to `expiresAt` an action must land for an auto-extending sandbox
 * to renew itself, when `defaults.autoExtendWindowSeconds` is not configured.
 */
const DEFAULT_AUTO_EXTEND_WINDOW_SECONDS = 30;

/** How often a deferred stop checks whether the capture in flight is over. */
const CAPTURE_POLL_MS = 2_000;
/**
 * Ceiling on that wait. Longer than any realistic capture (the largest observed
 * is ~3.5 min for 800 MB) but finite, so a capture whose process died without
 * clearing its flag cannot strand a container.
 */
const CAPTURE_WAIT_TIMEOUT_MS = 20 * 60_000;

@Injectable()
export class SandboxesService {
  private readonly logger = new Logger(SandboxesService.name);

  constructor(
    private readonly registry: SandboxRegistry,
    private readonly sandboxRepo: SandboxRepository,
    private readonly profileRepo: SandboxProfileRepository,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
    private readonly resourceUsage: ResourceUsageService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    @Optional() private readonly ingressService?: IngressService,
    @Optional()
    @Inject(forwardRef(() => HotPoolService))
    private readonly hotPool?: HotPoolService,
  ) {}

  async create(dto: CreateSandboxDto, scope: ExtensionScope): Promise<SandboxDocument> {
    if (dto.useHotPool && this.hotPool) {
      try {
        // The pool serves whatever it pre-warmed, so image/cpu/memory of a
        // profile can't be honored — but its TTL can, and must be: a caller
        // asking for a profile expects the sandbox to live as long as that
        // profile says, not as long as the module default.
        const ttlSeconds = dto.ttlSeconds ?? (await this.resolveProfileTtl(dto.profileId, scope));
        const claimed = await this.hotPool.claim({
          bindingId: dto.bindingId,
          ttlSeconds,
          autoExtend: dto.autoExtend,
        });
        this.logger.log(
          `Sandbox ${claimed.sandboxId} served from hot pool (binding=${dto.bindingId ?? '-'})`,
        );
        return await this.publishIfEnabled(claimed, scope);
      } catch (err) {
        this.logger.warn(
          `Hot pool claim failed, falling back to fresh create: ${(err as Error).message}`,
        );
      }
    }

    const defaults = this.config.defaults;

    let image = dto.image ?? defaults.defaultImage;
    let workdir = dto.workdir ?? '/workspace';
    let cpus = dto.cpus ?? defaults.defaultCpus;
    let memoryMib = dto.memoryMib ?? defaults.defaultMemoryMib;
    let envVars = dto.envVars ?? {};
    let initScript = dto.initScript ?? '';
    let ports = dto.ports ?? {};
    let ttlSeconds = dto.ttlSeconds ?? defaults.defaultTtlSeconds;
    let networkPolicy = dto.networkPolicy ?? 'allow-all';
    let exposedHttpPort = dto.exposedHttpPort;

    if (dto.profileId) {
      const profile = await this.profileRepo.findById(dto.profileId, scope);
      if (!profile) throw new NotFoundException(`Profile ${dto.profileId} not found`);

      image = dto.image ?? profile.image ?? image;
      workdir = dto.workdir ?? profile.workdir ?? workdir;
      cpus = dto.cpus ?? profile.cpus ?? cpus;
      memoryMib = dto.memoryMib ?? profile.memoryMib ?? memoryMib;
      envVars = { ...(profile.envVars ?? {}), ...(dto.envVars ?? {}) };
      initScript = dto.initScript ?? profile.initScript ?? initScript;
      ports = { ...(profile.ports ?? {}), ...(dto.ports ?? {}) };
      ttlSeconds = dto.ttlSeconds ?? profile.ttlSeconds ?? ttlSeconds;
      networkPolicy = dto.networkPolicy ?? profile.networkPolicy ?? networkPolicy;
      exposedHttpPort =
        dto.exposedHttpPort ?? profile.exposedHttpPort ?? exposedHttpPort;
    }

    if (ttlSeconds > defaults.maxTtlSeconds) {
      ttlSeconds = defaults.maxTtlSeconds;
    }

    // Image admission + host-port policy (Docker runtime). The provider applies
    // the same image allowlist as a backstop; rejecting here yields a clean 400
    // before any side effects. User-supplied host ports are dropped unless host
    // publishing is explicitly enabled — public exposure uses the ingress proxy.
    if (this.config.runtime.type === 'docker') {
      const dockerCfg = this.config.runtime.docker;
      if (!isImageAllowed(image, dockerCfg?.images?.allowlist)) {
        throw new BadRequestException(
          `Image '${image}' is not permitted by the configured allowlist`,
        );
      }
      const sanitized = sanitizeHostPorts(ports, {
        allow: dockerCfg?.allowHostPortPublishing ?? false,
      });
      if (sanitized.rejected.length > 0) {
        this.logger.warn(
          `Ignoring host port publishing (${sanitized.rejected.join(', ')}); ` +
            'set runtime.docker.allowHostPortPublishing=true to enable',
        );
      }
      ports = sanitized.ports;
    }

    // When ingress is enabled and the runtime is microsandbox, the public
    // proxy reaches the sandbox over a forwarded host port. Reserve a free
    // ephemeral port now and add it to the port mapping so the SDK forwards
    // the upstream HTTP port from the microVM out to localhost.
    if (
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

    await this.resourceUsage.assertMemoryAvailable(memoryMib);

    const sandboxId = nanoid(12);
    const containerName = `sandbox-${sandboxId}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const doc = await this.sandboxRepo.create(
      {
        sandboxId,
        name: containerName,
        profileId: dto.profileId,
        status: SandboxStatus.CREATING,
        image,
        workdir,
        currentCwd: workdir,
        cpus,
        memoryMib,
        envVars,
        ports,
        ttlSeconds,
        expiresAt,
        autoExtend: dto.autoExtend ?? false,
        bindingId: dto.bindingId,
        exposedHttpPort,
        commandCount: 0,
        recentCommands: [],
        metadata: {},
      } as any,
      scope,
    );

    try {
      const sandbox = await this.runtime.create({
        name: containerName,
        image,
        workdir,
        cpus,
        memoryMib,
        env: envVars,
        ports,
        networkPolicy: networkPolicy as 'allow-all' | 'deny-all',
      });
      await this.registry.register(sandboxId, containerName, ttlSeconds);

      if (initScript) {
        try {
          const result = await sandbox.exec(initScript);
          if (result.code !== 0) {
            this.logger.warn(
              `Init script exited with code ${result.code} for ${sandboxId}: ${result.stderr}`,
            );
          } else {
            this.logger.log(`Init script completed for ${sandboxId}`);
          }
        } catch (err) {
          this.logger.warn(
            `Init script failed for ${sandboxId}: ${(err as Error).message}`,
          );
        }
      }

      await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.RUNNING } },
        scope,
      );

      const updated = await this.sandboxRepo.findById((doc as any)._id.toString(), scope);
      return await this.publishIfEnabled(updated!, scope);
    } catch (err) {
      await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.FAILED } },
        scope,
      );
      throw err;
    }
  }

  /**
   * Align the Redis registry entry with a TTL that changed after the sandbox
   * was registered (hot pool claim). No-op when the sandbox has no entry.
   */
  async syncRegistryTtl(sandboxId: string, ttlSeconds: number): Promise<void> {
    await this.registry.extendTtl(sandboxId, ttlSeconds);
  }

  /**
   * TTL configured on a profile, or undefined when there is no profile (or it
   * carries no TTL) so the caller can fall back to the module default. A
   * missing profile is not an error here — the regular create path reports it.
   */
  private async resolveProfileTtl(
    profileId: string | undefined,
    scope: ExtensionScope,
  ): Promise<number | undefined> {
    if (!profileId) return undefined;
    try {
      const profile = await this.profileRepo.findById(profileId, scope);
      return profile?.ttlSeconds;
    } catch {
      return undefined;
    }
  }

  async findAll(
    scope: ExtensionScope,
    options?: {
      limit?: number;
      offset?: number;
      status?: string;
      snapshotId?: string;
      /** Only sandboxes served by the hot pool (true) or never pooled (false). */
      fromHotPool?: boolean;
      /** Only pods idle in the pool (true) or everything but them (false). */
      hotReserved?: boolean;
      /** `activity` (default) sorts by claim time, falling back to creation. */
      sortBy?: 'activity' | 'created';
    },
  ): Promise<PaginatedResponse<SandboxDocument>> {
    const filter: Record<string, any> = {};
    if (options?.status) filter.status = options.status;
    if (options?.hotReserved !== undefined) {
      filter.hotReserved = options.hotReserved
        ? true
        : { $ne: true };
    }
    if (options?.fromHotPool !== undefined) {
      const claimed = SandboxRepository.CLAIMED_FROM_POOL_FILTER;
      if (options.fromHotPool) Object.assign(filter, claimed);
      else filter.$nor = [claimed];
    }
    if (options?.snapshotId) {
      // A sandbox can point at a snapshot in three ways: a live link, a plain
      // restore, or the pool's source snapshot. Operators filtering by snapshot
      // mean "came from this snapshot", so match all three.
      filter.$and = [
        {
          $or: [
            { snapshotId: options.snapshotId },
            { 'metadata.restoredFrom': options.snapshotId },
            { 'metadata.hotPoolSnapshotId': options.snapshotId },
          ],
        },
      ];
    }

    if (options?.sortBy === 'created') {
      return this.sandboxRepo.find(filter, scope, options);
    }
    return this.sandboxRepo.findByActivity(filter, scope, options);
  }

  async findById(id: string, scope: ExtensionScope): Promise<SandboxDocument> {
    const doc =
      (await this.sandboxRepo.findOne({ sandboxId: id } as any, scope)) ??
      (await this.sandboxRepo.findById(id, scope));
    if (!doc) throw new NotFoundException(`Sandbox ${id} not found`);
    return doc;
  }

  async findByBinding(bindingId: string, scope: ExtensionScope): Promise<SandboxDocument | null> {
    return this.sandboxRepo.findByBinding(bindingId, scope);
  }

  async getOrCreateByBinding(
    bindingId: string,
    profileId: string | undefined,
    scope: ExtensionScope,
    options?: { autoExtend?: boolean },
  ): Promise<SandboxDocument> {
    const existing = await this.sandboxRepo.findByBinding(bindingId, scope);
    if (existing && existing.status === SandboxStatus.RUNNING) return existing;

    return this.create(
      { bindingId, profileId, autoExtend: options?.autoExtend },
      scope,
    );
  }

  private async getSandboxInstance(doc: SandboxDocument): Promise<RuntimeSandbox> {
    const containerName = await this.registry.get(doc.sandboxId);
    const name = containerName ?? doc.name;

    const handle = await this.runtime.get(name);
    if (!handle) {
      throw new BadRequestException(`Sandbox ${doc.sandboxId} is not reachable: not found`);
    }

    try {
      if (handle.status === 'running') {
        return await handle.connect();
      }
      return await handle.start();
    } catch (err) {
      this.logger.error(
        `Failed to reach sandbox ${doc.sandboxId} (name=${name}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new BadRequestException(
        `Sandbox ${doc.sandboxId} is not reachable: ${(err as Error).message}`,
      );
    }
  }

  async runCommand(
    id: string,
    dto: RunCommandDto,
    scope: ExtensionScope,
  ): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    await this.maybeAutoExtend(doc);

    const sandbox = await this.getSandboxInstance(doc);

    const command = dto.command.replace(/\bsudo\s+/g, '');
    const cwd = dto.cwd ?? doc.currentCwd ?? doc.workdir;

    // Reuse the sandbox-scoped persistent shell so `export VAR=…`, shell
    // functions and other in-shell state from previous tool calls remain
    // visible. `cd` is also real and persists, but we still pin the starting
    // cwd to whatever the caller asked for (or what we last recorded) so the
    // shell's own drift doesn't surprise the agent.
    const shell = await sandbox.openShell(cwd);
    // This REST endpoint is synchronous and sits behind a gateway that cuts the
    // origin request at ~60s. Default the per-command budget BELOW that (and
    // bound the queue wait, see DockerShellSession.runStream) so a stuck command
    // returns a clean exit-124 + shell reset instead of a 504. An explicit
    // `timeoutSeconds` overrides it (0 disables).
    const restDefaultMs = this.config.defaults?.restCommandTimeoutMs ?? 45000;
    const timeoutMs =
      dto.timeoutSeconds !== undefined
        ? dto.timeoutSeconds * 1000
        : restDefaultMs;
    let result;
    try {
      result = await shell.run(command, { cwd, env: dto.env, timeoutMs });
    } catch (err) {
      if (err instanceof ShellCommandTimeoutError) {
        // The command blew its time budget; the shell has been reset so later
        // commands start clean. Report it as a timeout (exit 124, the GNU
        // `timeout` convention) instead of failing the HTTP request, so callers
        // get an actionable result rather than a hung connection / 504.
        const seconds = Math.round(err.timeoutMs / 1000);
        return {
          code: 124,
          stdout: '',
          stderr: `command timed out after ${seconds}s and was aborted; the sandbox shell was reset`,
          cwd,
        };
      }
      // The shell was torn down out from under this command — e.g. a concurrent
      // command on the same sandbox timed out and reset the shared shell. The
      // command didn't fail on its own merits, so surface a clean, retryable
      // result (exit 124) instead of a 500.
      const message = (err as Error)?.message ?? '';
      if (/shell (session is closed|stream closed)/i.test(message)) {
        return {
          code: 124,
          stdout: '',
          stderr:
            'the sandbox shell was reset while this command was running; retry the command',
          cwd,
        };
      }
      throw err;
    }

    const newCwd = result.cwd || cwd;

    const recentCommands = [...(doc.recentCommands ?? []), dto.command].slice(-10);
    await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      {
        $set: { currentCwd: newCwd, recentCommands },
        $inc: { commandCount: 1 },
      },
      scope,
    );

    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: newCwd,
    };
  }

  async writeFile(
    id: string,
    filePath: string,
    content: string,
    scope: ExtensionScope,
  ): Promise<void> {
    const doc = await this.findById(id, scope);
    await this.maybeAutoExtend(doc);
    const sandbox = await this.getSandboxInstance(doc);
    await sandbox.writeFile(filePath, Buffer.from(content));
  }

  async readFile(
    id: string,
    filePath: string,
    scope: ExtensionScope,
  ): Promise<string> {
    const doc = await this.findById(id, scope);
    await this.maybeAutoExtend(doc);
    const sandbox = await this.getSandboxInstance(doc);
    const data = await sandbox.readFile(filePath);
    return data.toString('utf-8');
  }

  // ---------------------------------------------------------------------------
  // File explorer
  // ---------------------------------------------------------------------------

  /**
   * Structured listing of a directory's direct children. Defaults to the
   * sandbox's current working directory when no path is given.
   */
  async listFiles(
    id: string,
    dirPath: string | undefined,
    scope: ExtensionScope,
  ): Promise<{ path: string; entries: SandboxFileEntry[] }> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(
        `Sandbox is not running (status: ${doc.status})`,
      );
    }
    // Browsing the file explorer runs a command in the sandbox like any other
    // action, so it counts as use too.
    await this.maybeAutoExtend(doc);
    const sandbox = await this.getSandboxInstance(doc);
    const target = dirPath || doc.currentCwd || doc.workdir;

    const result = await sandbox.exec(buildListDirScript(target));
    const parsed = parseListDirOutput(result.stdout);
    if ('error' in parsed) {
      throw new BadRequestException(
        parsed.error === 'missing'
          ? `Path not found: ${target}`
          : `Not a directory: ${target}`,
      );
    }
    return { path: target, entries: parsed.entries };
  }

  /**
   * Stream a file out of the sandbox. The runtime copies it to a host temp
   * file (streamed, binary-safe on both runtimes) which is unlinked once the
   * response stream closes.
   */
  async downloadFile(
    id: string,
    filePath: string,
    scope: ExtensionScope,
  ): Promise<{ stream: Readable; filename: string; sizeBytes?: number }> {
    if (!filePath) throw new BadRequestException('path is required');
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(
        `Sandbox is not running (status: ${doc.status})`,
      );
    }
    await this.maybeAutoExtend(doc);
    const sandbox = await this.getSandboxInstance(doc);

    const hostTmp = join(tmpdir(), `operator-dl-${nanoid(10)}`);
    try {
      await sandbox.copyToHost(filePath, hostTmp);
    } catch (err) {
      throw new BadRequestException(
        `Could not read ${filePath}: ${(err as Error).message}`,
      );
    }

    let sizeBytes: number | undefined;
    try {
      sizeBytes = statSync(hostTmp).size;
    } catch {}

    const stream = createReadStream(hostTmp);
    stream.on('close', () => rm(hostTmp, { force: true }, () => {}));
    return { stream, filename: posixPath.basename(filePath), sizeBytes };
  }

  /**
   * Upload a file into the sandbox. Destinations ending in `/` get the
   * original filename appended. Writes are confined to the workspace.
   */
  async uploadFile(
    id: string,
    destPath: string,
    file: Express.Multer.File,
    scope: ExtensionScope,
  ): Promise<{ path: string; sizeBytes: number }> {
    if (!file) {
      throw new BadRequestException("multipart field 'file' is required");
    }
    try {
      const doc = await this.findById(id, scope);
      if (doc.status !== SandboxStatus.RUNNING) {
        throw new BadRequestException(
          `Sandbox is not running (status: ${doc.status})`,
        );
      }
      await this.maybeAutoExtend(doc);
      const sandbox = await this.getSandboxInstance(doc);

      let target = destPath || `${doc.workdir}/`;
      if (target.endsWith('/')) target = target + file.originalname;
      const safePath = this.confineUploadToWorkspace(target, doc.workdir);

      await sandbox.copyFromHost(file.path, safePath);
      return { path: safePath, sizeBytes: file.size };
    } finally {
      try {
        if (file?.path && existsSync(file.path)) unlinkSync(file.path);
      } catch {}
    }
  }

  /**
   * Resolve an upload destination and require it to stay inside the sandbox
   * workspace. Relative paths resolve against the workdir.
   */
  private confineUploadToWorkspace(p: string, workdir: string): string {
    const absolute = p.startsWith('/') ? p : posixPath.join(workdir, p);
    const normalized = posixPath.normalize(absolute);
    const root = workdir.endsWith('/') ? workdir : `${workdir}/`;
    if (normalized !== workdir && !normalized.startsWith(root)) {
      throw new BadRequestException(
        `Uploads are restricted to the workspace (${workdir})`,
      );
    }
    return normalized;
  }

  /**
   * Stop a running sandbox. `reason` records a stop the owner did not ask for
   * (currently only the disk cap) so the API and the UI can explain it.
   */
  async stop(
    id: string,
    scope: ExtensionScope,
    reason?: string,
    opts: StopSandboxDto = {},
  ): Promise<SandboxDocument> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    // A capture is already reading this filesystem (a snapshot created with
    // `async`, or a save from another path). An async caller does not need it
    // to be over — it asked us to finish off-request, so we wait it out and
    // tear down after. A synchronous one is refused rather than kept hanging.
    if (doc.savingSnapshotId && !opts.force) {
      if (!opts.async) this.assertNotBeingCaptured(doc, opts.force);
      const stopping = await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.STOPPING } },
        scope,
      );
      void this.waitForCaptureThenStop(doc, scope, reason);
      return stopping ?? doc;
    }

    const shouldSave = opts.save !== false && !!doc.snapshotId;

    // Async stop: claim the work, answer now, finish off-request. The save and
    // the teardown stay in this order and in one place — a caller that saved
    // over HTTP and then stopped separately used to race its own capture, and
    // stopping the container SIGKILLs the tar reading its filesystem.
    if (shouldSave && opts.async) {
      const stopping = await this.sandboxRepo.updateById(
        (doc as any)._id.toString(),
        { $set: { status: SandboxStatus.STOPPING } },
        scope,
      );
      void this.saveThenStop(doc, scope, reason);
      return stopping ?? doc;
    }

    if (shouldSave) {
      const outcome = await this.snapshotsService.persistToSnapshot(doc);
      if (outcome === 'conflict') {
        throw new ConflictException({
          message:
            'Another save into this sandbox snapshot is already running. ' +
            'Retry once it finishes.',
          code: 'SNAPSHOT_SAVE_IN_PROGRESS',
          snapshotId: doc.snapshotId,
        });
      }
    }

    return this.finishStop(doc, scope, reason);
  }

  /**
   * Background half of an async stop: persist, then tear down no matter how the
   * save went. A failed save must not leave the sandbox running forever — the
   * caller already got its answer and nothing else will come back for it.
   */
  private async saveThenStop(
    doc: SandboxDocument,
    scope: ExtensionScope,
    reason?: string,
  ): Promise<void> {
    try {
      await this.snapshotsService.persistToSnapshot(doc);
    } catch (err) {
      this.logger.error(
        `Background save for ${doc.sandboxId} failed: ${(err as Error).message}`,
      );
    }
    try {
      await this.finishStop(doc, scope, reason);
    } catch (err) {
      this.logger.error(
        `Background stop for ${doc.sandboxId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Wait for the capture in flight to clear the sandbox's flag, then tear the
   * container down. No second save: the capture already running IS the save.
   *
   * Bounded — a capture that never finishes (its process died without clearing
   * the flag, which the boot sweep only fixes on restart) must not leave the
   * container running forever.
   */
  private async waitForCaptureThenStop(
    doc: SandboxDocument,
    scope: ExtensionScope,
    reason?: string,
  ): Promise<void> {
    const deadline = Date.now() + CAPTURE_WAIT_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, CAPTURE_POLL_MS));
        const fresh = await this.sandboxRepo
          .findOne({ sandboxId: doc.sandboxId } as any, scope)
          .catch(() => null);
        if (!fresh) return;
        if (!fresh.savingSnapshotId) {
          await this.finishStop(fresh, scope, reason);
          return;
        }
      }
      this.logger.warn(
        `Capture of ${doc.sandboxId} did not finish within ` +
          `${CAPTURE_WAIT_TIMEOUT_MS}ms; stopping anyway`,
      );
      await this.finishStop(doc, scope, reason);
    } catch (err) {
      this.logger.error(
        `Deferred stop for ${doc.sandboxId} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Refuse to tear down a container whose filesystem is being captured. */
  private assertNotBeingCaptured(doc: SandboxDocument, force?: boolean): void {
    if (!doc.savingSnapshotId || force) return;
    throw new ConflictException({
      message:
        'A snapshot save is capturing this sandbox. Tearing it down now would ' +
        'kill the capture and lose the save. Retry once it finishes, or pass ' +
        'force=true to abandon it.',
      code: 'SNAPSHOT_SAVE_IN_PROGRESS',
      snapshotId: doc.savingSnapshotId,
    });
  }

  private async finishStop(
    doc: SandboxDocument,
    scope: ExtensionScope,
    reason?: string,
  ): Promise<SandboxDocument> {
    try {
      // Address the container through the document, not the Redis registry:
      // the registry key expires with the TTL and a lapsed key would leave the
      // container running while the document reads as stopped.
      const handle = await this.runtime.get(doc.name);
      if (handle?.status === 'running') {
        const sandbox = await handle.connect();
        await sandbox.detach();
      }
    } catch (err) {
      this.logger.warn(`Error stopping sandbox ${doc.sandboxId}: ${(err as Error).message}`);
    }

    await this.registry.remove(doc.sandboxId);

    if (this.ingressService?.isEnabled()) {
      try {
        await this.ingressService.unpublish(doc);
      } catch (err) {
        this.logger.warn(
          `Ingress unpublish failed for ${doc.sandboxId}: ${(err as Error).message}`,
        );
      }
    }

    const updated = await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      {
        $set: {
          status: SandboxStatus.STOPPED,
          ...(reason ? { stoppedReason: reason } : {}),
        },
        $unset: { publicUrl: '', internalEndpoint: '' },
      },
      scope,
    );

    // Opportunistic cleanup: reclaim any per-sandbox networks left behind by
    // sandboxes that no longer exist, so the daemon's address pool does not
    // exhaust. Piggybacks on stop events instead of a dedicated cron. Never
    // let a sweep failure surface as a failed stop.
    await this.runtime.sweepOrphanedNetworks?.().catch((err) => {
      this.logger.warn(
        `Network sweep after stopping ${doc.sandboxId} failed: ${(err as Error).message}`,
      );
    });

    return updated!;
  }

  async destroy(
    id: string,
    scope: ExtensionScope,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const doc = await this.findById(id, scope);
    this.assertNotBeingCaptured(doc, opts.force);

    try {
      await this.runtime.remove(doc.name);
    } catch (err) {
      this.logger.warn(`Error removing sandbox ${doc.sandboxId}: ${(err as Error).message}`);
    }

    if (this.ingressService?.isEnabled()) {
      try {
        await this.ingressService.unpublish(doc);
      } catch (err) {
        this.logger.warn(
          `Ingress unpublish failed for ${doc.sandboxId}: ${(err as Error).message}`,
        );
      }
    }

    await this.registry.remove(doc.sandboxId);
    await this.sandboxRepo.deleteById((doc as any)._id.toString(), scope);
  }

  async extendTtl(
    id: string,
    additionalSeconds: number,
    scope: ExtensionScope,
  ): Promise<SandboxDocument> {
    const doc = await this.findById(id, scope);
    if (doc.status !== SandboxStatus.RUNNING) {
      throw new BadRequestException(`Sandbox is not running (status: ${doc.status})`);
    }

    // Additive semantics: additionalSeconds extends the CURRENT expiry, it is
    // not the new remaining time. Anchoring on Date.now() instead silently
    // SHORTENS the lifetime whenever the remaining time exceeds the extension,
    // desynchronizing clients that track expiresAt += additionalSeconds.
    const currentExpiresAtMs = new Date(doc.expiresAt).getTime();
    const newExpiresAtMs = currentExpiresAtMs + additionalSeconds * 1000;

    if (newExpiresAtMs > this.ttlCeilingMs(doc)) {
      throw new BadRequestException(
        `Total TTL would exceed maximum of ${this.config.defaults.maxTtlSeconds}s`,
      );
    }

    const newExpiresAt = new Date(newExpiresAtMs);
    const updated = await this.sandboxRepo.updateById(
      (doc as any)._id.toString(),
      { $set: { expiresAt: newExpiresAt } },
      scope,
    );

    await this.syncTtlSideEffects(updated!, newExpiresAt);

    return updated!;
  }

  // ---------------------------------------------------------------------------
  // Auto-extension
  // ---------------------------------------------------------------------------

  /**
   * Renew a sandbox that is still being used, so a session does not die under
   * the caller's hands mid-task.
   *
   * Only sandboxes created with `autoExtend: true` are eligible, and only when
   * the action arrives inside the renewal window — a sandbox with plenty of
   * time left is not touched, so this costs one date comparison on the hot
   * path. Every action that reaches the sandbox counts as use: commands, file
   * reads and writes, uploads and downloads.
   *
   * Runs *before* the action rather than after: a command issued with five
   * seconds left would otherwise be reaped halfway through.
   *
   * Best-effort by construction — a sandbox that cannot be renewed (it hit
   * `maxTtlSeconds`, Redis is down, another action won the race) still serves
   * the action it was called for, so nothing here is allowed to throw.
   */
  private async maybeAutoExtend(doc: SandboxDocument): Promise<void> {
    if (!doc.autoExtend) return;
    if (doc.status !== SandboxStatus.RUNNING) return;

    try {
      const currentExpiresAt = new Date(doc.expiresAt);
      const remainingMs = currentExpiresAt.getTime() - Date.now();
      // Past the expiry the reaper owns this document — it may be inside
      // `atomicExpire` right now — and moving `expiresAt` would leave a
      // document reading RUNNING with its container already gone.
      if (remainingMs <= 0 || remainingMs > this.autoExtendWindowMs) return;

      const grantedMs = this.autoExtendGrantMs(doc, currentExpiresAt);
      if (grantedMs <= 0) {
        this.logger.debug(
          `Sandbox ${doc.sandboxId} reached the ${this.config.defaults.maxTtlSeconds}s ` +
            'TTL ceiling; not auto-extending',
        );
        return;
      }

      const newExpiresAt = new Date(currentExpiresAt.getTime() + grantedMs);
      const updated = await this.sandboxRepo.atomicExtendExpiry(
        (doc as any)._id.toString(),
        currentExpiresAt,
        newExpiresAt,
      );
      // Lost the compare-and-set: a concurrent action already renewed this
      // sandbox (or the reaper moved it out of RUNNING). Either way there is
      // nothing left to do.
      if (!updated) return;

      await this.syncTtlSideEffects(updated, newExpiresAt);
      this.logger.log(
        `Sandbox ${doc.sandboxId} auto-extended by ${Math.round(grantedMs / 1000)}s ` +
          `on activity (expires ${newExpiresAt.toISOString()})`,
      );
    } catch (err) {
      this.logger.warn(
        `Auto-extend failed for ${doc.sandboxId}: ${(err as Error).message}`,
      );
    }
  }

  private get autoExtendWindowMs(): number {
    const seconds =
      this.config.defaults?.autoExtendWindowSeconds ??
      DEFAULT_AUTO_EXTEND_WINDOW_SECONDS;
    return seconds * 1000;
  }

  /**
   * Latest instant a sandbox may be extended to, whether the extension was
   * asked for explicitly or granted automatically.
   *
   * Measured from when the sandbox started serving its owner rather than from
   * `createdAt`: for a sandbox claimed from the hot pool `createdAt` records
   * when the pod was pre-warmed — potentially days earlier — which would leave
   * it with no extension budget at all the moment it was handed out.
   */
  private ttlCeilingMs(doc: SandboxDocument): number {
    const anchor = doc.claimedAt ?? (doc as any).createdAt;
    return new Date(anchor).getTime() + this.config.defaults.maxTtlSeconds * 1000;
  }

  /**
   * Milliseconds an auto-extension may add: another full `ttlSeconds`, clamped
   * to the ceiling above. Zero once the ceiling is reached — the sandbox then
   * expires normally, however busy it is.
   */
  private autoExtendGrantMs(doc: SandboxDocument, currentExpiresAt: Date): number {
    const desiredMs = currentExpiresAt.getTime() + doc.ttlSeconds * 1000;
    return Math.max(
      0,
      Math.min(desiredMs, this.ttlCeilingMs(doc)) - currentExpiresAt.getTime(),
    );
  }

  /**
   * Carry a new expiry over to everything that caches it: the Redis registry
   * keyed by sandbox id, and the ingress mapping for a published sandbox.
   * Neither is the source of truth (the document is), so a failure here is
   * logged and not propagated.
   */
  private async syncTtlSideEffects(
    doc: SandboxDocument,
    newExpiresAt: Date,
  ): Promise<void> {
    // Registry TTL is "seconds remaining from now" (redis EXPIRE), so convert.
    const remainingSeconds = Math.max(
      1,
      Math.ceil((newExpiresAt.getTime() - Date.now()) / 1000),
    );
    await this.registry.extendTtl(doc.sandboxId, remainingSeconds);

    if (this.ingressService?.isEnabled() && doc.subdomain) {
      try {
        await this.ingressService.refreshTtl(doc);
      } catch (err) {
        this.logger.warn(
          `Ingress TTL refresh failed for ${doc.sandboxId}: ${(err as Error).message}`,
        );
      }
    }
  }

  async getStatus(id: string, scope: ExtensionScope) {
    const doc = await this.findById(id, scope);
    const remainingMs = Math.max(0, new Date(doc.expiresAt).getTime() - Date.now());

    return {
      sandboxId: doc.sandboxId,
      status: doc.status,
      image: doc.image,
      cpus: doc.cpus,
      memoryMib: doc.memoryMib,
      currentCwd: doc.currentCwd,
      commandCount: doc.commandCount,
      remainingSeconds: Math.floor(remainingMs / 1000),
      expiresAt: doc.expiresAt,
      ttlSeconds: doc.ttlSeconds,
      autoExtend: doc.autoExtend ?? false,
      publicUrl: doc.publicUrl,
      createdAt: (doc as any).createdAt,
    };
  }

  /**
   * Publish the sandbox under its public subdomain when ingress is enabled,
   * persist the resulting URL on the doc and return the refreshed document.
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

  /**
   * Bind to port 0 on loopback to let the kernel pick a free TCP port, then
   * release it. The chosen number can race with another process taking the
   * same port between this call and the actual bind by the runtime, but in
   * practice the window is short enough to be acceptable for a dev/staging
   * sandbox host. Used only to back the microsandbox host-port forwarding.
   */
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
}
