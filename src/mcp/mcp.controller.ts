import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Param,
  OnModuleInit,
  Inject,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SandboxesService } from '../sandboxes/sandboxes.service';
import { McpProfilesService } from './profiles/mcp-profiles.service';
import { McpProfile } from '../schemas/mcp-profile.schema';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { MCP_TOOL_NAMES } from './available-tools';

interface ResolvedProfile {
  profile: McpProfile;
  profileId: string;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  profile: ResolvedProfile | null;
  sandboxId: string | null;
}

@Controller('mcp')
export class McpController implements OnModuleInit {
  private readonly logger = new Logger(McpController.name);
  private enabled = false;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly sandboxesService: SandboxesService,
    private readonly profilesService: McpProfilesService,
    @Inject(CONFIG) private readonly config: ModuleConfig,
  ) {}

  onModuleInit() {
    if (!this.config.mcp?.enabled) {
      this.logger.warn('MCP server is disabled in configuration');
      return;
    }
    this.enabled = true;
    this.logger.log('MCP server initialized with sandbox tools');
  }

  private canUseTool(resolved: ResolvedProfile | null, toolName: string, isWrite: boolean): boolean {
    if (!resolved) return true;
    if (resolved.profile.readOnly && isWrite) return false;
    const allowed = resolved.profile.allowedTools ?? [];
    if (allowed.length === 0) return false;
    return allowed.includes(toolName);
  }

  private async createServer(
    resolved: ResolvedProfile | null,
    session: SessionEntry,
  ): Promise<McpServer> {
    const server = new McpServer({
      name: resolved
        ? `devic-sandbox (${resolved.profile.name})`
        : 'devic-sandbox',
      version: process.env.npm_package_version ?? '0.1.0',
    });
    this.registerTools(server, resolved, session);
    return server;
  }

  private async getOrCreateSessionSandbox(session: SessionEntry): Promise<string> {
    if (session.sandboxId) return session.sandboxId;

    const profileId = session.profile?.profile.defaultSandboxProfileId;
    const scope = {};
    const sandbox = await this.sandboxesService.create({ profileId }, scope);
    session.sandboxId = sandbox.sandboxId;
    return sandbox.sandboxId;
  }

  private registerTools(
    server: McpServer,
    resolved: ResolvedProfile | null,
    session: SessionEntry,
  ) {
    const errorResult = (msg: string) => ({
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    });

    if (this.canUseTool(resolved, 'create_sandbox', true)) {
      server.tool(
        'create_sandbox',
        'Create a new sandbox environment or reuse an existing one via bindingId.',
        {
          profileId: z.string().optional().describe('Sandbox profile ID'),
          bindingId: z.string().optional().describe('External binding ID'),
          image: z.string().optional().describe('Docker image'),
          ttlSeconds: z.number().optional().describe('TTL in seconds'),
        } as any,
        async ({ profileId, bindingId, image, ttlSeconds }: any) => {
          try {
            const scope = {};
            let sandbox;

            if (bindingId) {
              sandbox = await this.sandboxesService.getOrCreateByBinding(
                bindingId,
                profileId ?? session.profile?.profile.defaultSandboxProfileId,
                scope,
              );
            } else {
              sandbox = await this.sandboxesService.create(
                {
                  profileId: profileId ?? session.profile?.profile.defaultSandboxProfileId,
                  image,
                  ttlSeconds,
                },
                scope,
              );
            }

            session.sandboxId = sandbox.sandboxId;

            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: sandbox.sandboxId,
                status: sandbox.status,
                image: sandbox.image,
                workdir: sandbox.workdir,
                ttlSeconds: sandbox.ttlSeconds,
                expiresAt: sandbox.expiresAt,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'run_command', true)) {
      server.tool(
        'run_command',
        'Execute a shell command in the active sandbox.',
        {
          command: z.string().describe('Shell command to execute'),
          cwd: z.string().optional().describe('Working directory override'),
        } as any,
        async ({ command, cwd }: { command: string; cwd?: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            const result = await this.sandboxesService.runCommand(
              sandboxId,
              { command, cwd },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'write_file', true)) {
      server.tool(
        'write_file',
        'Write content to a file in the sandbox.',
        {
          path: z.string().describe('File path'),
          content: z.string().describe('File content'),
        } as any,
        async ({ path, content }: { path: string; content: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            await this.sandboxesService.writeFile(sandboxId, path, content, {});
            return {
              content: [{ type: 'text' as const, text: `File written: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'create_directory', true)) {
      server.tool(
        'create_directory',
        'Create a directory in the sandbox.',
        {
          path: z.string().describe('Directory path to create'),
        } as any,
        async ({ path }: { path: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            await this.sandboxesService.runCommand(
              sandboxId,
              { command: `mkdir -p '${path}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: `Directory created: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'stop_sandbox', true)) {
      server.tool(
        'stop_sandbox',
        'Stop the active sandbox. Creates a snapshot for potential restore.',
        {} as any,
        async () => {
          try {
            if (!session.sandboxId) {
              return errorResult('No active sandbox in this session');
            }
            const result = await this.sandboxesService.stop(session.sandboxId, {});
            session.sandboxId = null;
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: result.sandboxId,
                status: result.status,
                snapshotId: result.snapshotId,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'extend_ttl', true)) {
      server.tool(
        'extend_ttl',
        'Extend the time to live of the active sandbox.',
        {
          additionalSeconds: z.number().describe('Additional seconds to add'),
        } as any,
        async ({ additionalSeconds }: { additionalSeconds: number }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            const result = await this.sandboxesService.extendTtl(
              sandboxId,
              additionalSeconds,
              {},
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: result.sandboxId,
                expiresAt: result.expiresAt,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'upload_file', true)) {
      server.tool(
        'upload_file',
        'Download a file from a URL and save it to the sandbox.',
        {
          url: z.string().describe('Public URL to download from'),
          path: z.string().describe('Destination path in the sandbox'),
        } as any,
        async ({ url, path }: { url: string; path: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            await this.sandboxesService.runCommand(
              sandboxId,
              { command: `curl -fsSL -o '${path}' '${url}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: `File downloaded to: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'get_sandbox_status', false)) {
      server.tool(
        'get_sandbox_status',
        'Get the current status of the sandbox including remaining TTL.',
        {} as any,
        async () => {
          try {
            if (!session.sandboxId) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  status: 'no_sandbox',
                  message: 'No sandbox attached to this session',
                }, null, 2) }],
              };
            }
            const status = await this.sandboxesService.getStatus(session.sandboxId, {});
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'list_files', false)) {
      server.tool(
        'list_files',
        'List files and directories in the sandbox.',
        {
          path: z.string().optional().describe('Directory path (default: current working directory)'),
        } as any,
        async ({ path }: { path?: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            const dir = path || '.';
            const result = await this.sandboxesService.runCommand(
              sandboxId,
              { command: `ls -la '${dir}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: result.stdout }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'read_file', false)) {
      server.tool(
        'read_file',
        'Read the content of a file in the sandbox.',
        {
          path: z.string().describe('File path to read'),
        } as any,
        async ({ path }: { path: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            const content = await this.sandboxesService.readFile(
              sandboxId,
              path,
              {},
            );
            return {
              content: [{ type: 'text' as const, text: content }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'download_file', false)) {
      server.tool(
        'download_file',
        'Get the content of a file from the sandbox encoded in base64.',
        {
          path: z.string().describe('File path to download'),
        } as any,
        async ({ path }: { path: string }) => {
          try {
            const sandboxId = await this.getOrCreateSessionSandbox(session);
            const content = await this.sandboxesService.readFile(
              sandboxId,
              path,
              {},
            );
            const base64 = Buffer.from(content).toString('base64');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                path,
                encoding: 'base64',
                data: base64,
                sizeBytes: Buffer.byteLength(content),
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    void MCP_TOOL_NAMES;
  }

  // HTTP entrypoints
  @Post()
  handlePostRoot(@Req() req: Request, @Res() res: Response) {
    return this.handlePost(req, res, undefined);
  }

  @Post(':profileId')
  handlePostProfile(
    @Param('profileId') profileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handlePost(req, res, profileId);
  }

  @Get()
  handleGetRoot(@Req() req: Request, @Res() res: Response) {
    return this.handleGet(req, res);
  }

  @Get(':profileId')
  handleGetProfile(@Req() req: Request, @Res() res: Response) {
    return this.handleGet(req, res);
  }

  @Delete()
  handleDeleteRoot(@Req() req: Request, @Res() res: Response) {
    return this.handleDelete(req, res);
  }

  @Delete(':profileId')
  handleDeleteProfile(@Req() req: Request, @Res() res: Response) {
    return this.handleDelete(req, res);
  }

  private async handlePost(
    req: Request,
    res: Response,
    profileId: string | undefined,
  ) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      if (sessionId && this.sessions.has(sessionId)) {
        transport = this.sessions.get(sessionId)!.transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        let resolved: ResolvedProfile | null = null;
        if (profileId) {
          const profile = await this.profilesService.resolveProfile(profileId);
          if (!profile) {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32000, message: `MCP profile ${profileId} not found` },
              id: null,
            });
            return;
          }
          resolved = {
            profile,
            profileId: (profile as any)._id.toString(),
          };
        }

        const sessionEntry: SessionEntry = {
          transport: null as any,
          profile: resolved,
          sandboxId: null,
        };

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            this.logger.log(
              `MCP session initialized: ${sid}${resolved ? ` (profile: ${resolved.profile.name})` : ''}`,
            );
            sessionEntry.transport = transport!;
            this.sessions.set(sid, sessionEntry);
          },
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            this.logger.log(`MCP session closed: ${transport!.sessionId}`);
            this.sessions.delete(transport!.sessionId);
          }
        };

        const server = await this.createServer(resolved, sessionEntry);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await transport!.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(`MCP POST error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }

  private async handleGet(req: Request, res: Response) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      this.logger.error(`MCP GET error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }

  private async handleDelete(req: Request, res: Response) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      this.logger.error(`MCP DELETE error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }
}
