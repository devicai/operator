import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  ExecStream,
} from '../runtime/runtime-provider.interface';

interface ClientSession {
  sandboxId: string;
  activeStream: ExecStream | null;
  alive: boolean;
}

@WebSocketGateway({ path: '/ws/terminal' })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<WebSocket, ClientSession>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly registry: SandboxRegistry,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Terminal client connected');

    client.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());

        if (msg.type === 'attach' && msg.sandboxId) {
          await this.attachToSandbox(client, msg.sandboxId);
        } else if (msg.type === 'command' && msg.command) {
          await this.executeCommand(client, msg.command);
        }
      } catch (err) {
        this.send(client, {
          type: 'error',
          data: `Error: ${(err as Error).message}`,
        });
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session) {
      session.alive = false;
      session.activeStream?.stop().catch(() => undefined);
      this.sessions.delete(client);
      this.logger.log(`Terminal client disconnected (sandbox: ${session.sandboxId})`);
    }
  }

  private async attachToSandbox(client: WebSocket, sandboxId: string): Promise<void> {
    const containerName = await this.registry.get(sandboxId);
    if (!containerName) {
      this.send(client, { type: 'error', data: 'Sandbox not found or not running' });
      return;
    }

    this.sessions.set(client, {
      sandboxId,
      activeStream: null,
      alive: true,
    });

    this.send(client, {
      type: 'attached',
      data: `Connected to sandbox ${sandboxId}\r\n`,
    });
  }

  private async executeCommand(client: WebSocket, command: string): Promise<void> {
    const session = this.sessions.get(client);
    if (!session?.alive) {
      this.send(client, { type: 'error', data: 'Not attached to any sandbox' });
      return;
    }

    const containerName = await this.registry.get(session.sandboxId);
    if (!containerName) {
      this.send(client, { type: 'error', data: 'Sandbox no longer available' });
      return;
    }

    try {
      const handle = await this.runtime.get(containerName);
      if (!handle || handle.status !== 'running') {
        this.send(client, { type: 'error', data: 'Sandbox is not running' });
        return;
      }
      const sandbox = await handle.connect();
      const stream = await sandbox.execStream(command);
      session.activeStream = stream;

      try {
        for await (const event of stream.events) {
          if (!session.alive) break;
          this.send(client, {
            type: event.type,
            data: event.data.toString('utf-8'),
          });
        }
      } finally {
        await stream.stop().catch(() => undefined);
        if (session.activeStream === stream) {
          session.activeStream = null;
        }
      }

      this.send(client, { type: 'done' });
    } catch (err) {
      this.send(client, {
        type: 'error',
        data: `Command error: ${(err as Error).message}`,
      });
    }
  }

  private send(client: WebSocket, data: any): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}
