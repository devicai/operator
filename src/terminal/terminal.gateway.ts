import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { Sandbox as MsbSandbox } from 'microsandbox';
import type { ExecHandle, ExecEvent } from 'microsandbox';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';

interface ClientSession {
  sandboxId: string;
  handle: ExecHandle | null;
  alive: boolean;
}

@WebSocketGateway({ path: '/ws/terminal' })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<WebSocket, ClientSession>();

  @WebSocketServer()
  server: Server;

  constructor(private readonly registry: SandboxRegistry) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Terminal client connected');

    client.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());

        if (msg.type === 'attach' && msg.sandboxId) {
          await this.attachToSandbox(client, msg.sandboxId);
        } else if (msg.type === 'input' && msg.data) {
          // Input to sandbox stdin - handled by the streaming shell
          // For interactive terminals, each input triggers a new shell command
          const session = this.sessions.get(client);
          if (session?.alive) {
            // We use shell for each input line instead of stdin
            // since microsandbox shellStream doesn't support stdin writing
            // The client should send complete commands
          }
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
      handle: null,
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
      const handle = await MsbSandbox.get(containerName);
      const sandbox = await handle.connect();
      const execHandle = await sandbox.shellStream(command);

      let event: ExecEvent | null;
      while ((event = await execHandle.recv()) !== null) {
        if (!session.alive) break;

        if (event.eventType === 'stdout' && event.data) {
          this.send(client, {
            type: 'stdout',
            data: event.data.toString('utf-8'),
          });
        } else if (event.eventType === 'stderr' && event.data) {
          this.send(client, {
            type: 'stderr',
            data: event.data.toString('utf-8'),
          });
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
