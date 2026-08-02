import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as http from 'http';
import * as net from 'net';
import { Duplex } from 'stream';
import { CONFIG } from '../config/config.loader';
import { IngressConfig, ModuleConfig } from '../config/config.types';
import { IngressRegistry } from './ingress-registry';
import { SandboxWakeupService } from './sandbox-wakeup.service';
import {
  STATUS_PATH,
  disabledPage,
  errorPage,
  notFoundPage,
  waitingPage,
} from './wakeup-page';

/**
 * Embedded HTTP reverse proxy that routes requests to running sandboxes by
 * Host header. Listens on `ingress.proxyPort` (separate from the API server)
 * and only speaks plain HTTP — TLS termination is expected upstream.
 *
 * For each request:
 *   1. Parse the Host header.
 *   2. Strip the configured wildcard domain to obtain the subdomain label.
 *   3. Read `sandbox:ingress:<subdomain>` from Redis to get the upstream
 *      `host:port` (the runtime provider populated this on publish).
 *   4. Forward the HTTP request (or WebSocket upgrade) to that upstream.
 */
@Injectable()
export class IngressProxyServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngressProxyServer.name);
  private server: http.Server | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly registry: IngressRegistry,
    private readonly wakeup: SandboxWakeupService,
  ) {}

  async onModuleInit(): Promise<void> {
    const cfg = this.config.ingress;
    if (!cfg?.enabled) return;

    const resolved = this.resolved(cfg);
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res, resolved).catch((err) => {
        this.logger.warn(
          `Unhandled proxy error for ${req.headers.host}${req.url}: ${(err as Error).message}`,
        );
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        if (res.writable) res.end('Bad Gateway');
      });
    });

    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head, resolved).catch((err) => {
        this.logger.warn(
          `Upgrade failed for ${req.headers.host}${req.url}: ${(err as Error).message}`,
        );
        try {
          socket.destroy();
        } catch {}
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(resolved.proxyPort, resolved.proxyHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.logger.log(
      `Public ingress proxy listening on http://${resolved.proxyHost}:${resolved.proxyPort} for *.${resolved.wildcardDomain}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  // --- Internals --------------------------------------------------------

  private resolved(cfg: IngressConfig): Required<
    Pick<
      IngressConfig,
      | 'wildcardDomain'
      | 'proxyHost'
      | 'proxyPort'
      | 'upstreamTimeoutMs'
      | 'defaultUpstreamPort'
    >
  > {
    return {
      wildcardDomain: cfg.wildcardDomain,
      proxyHost: cfg.proxyHost ?? '0.0.0.0',
      proxyPort: cfg.proxyPort ?? 8080,
      upstreamTimeoutMs: cfg.upstreamTimeoutMs ?? 30000,
      defaultUpstreamPort: cfg.defaultUpstreamPort ?? 80,
    };
  }

  /** Pull the lowercase subdomain label out of a Host header. */
  private extractSubdomain(
    hostHeader: string | undefined,
    wildcardDomain: string,
  ): string | null {
    if (!hostHeader) return null;
    const host = hostHeader.split(':')[0]?.toLowerCase().trim();
    if (!host) return null;
    const suffix = `.${wildcardDomain.toLowerCase()}`;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    if (!label || label.includes('/')) return null;
    return label;
  }

  private async resolveUpstream(
    req: http.IncomingMessage,
    wildcardDomain: string,
  ): Promise<{ host: string; port: number; sandboxId: string } | null> {
    const subdomain = this.extractSubdomain(req.headers.host, wildcardDomain);
    if (!subdomain) return null;
    const entry = await this.registry.lookup(subdomain);
    if (!entry) return null;
    return {
      host: entry.upstreamHost,
      port: entry.upstreamPort,
      sandboxId: entry.sandboxId,
    };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cfg: ReturnType<IngressProxyServer['resolved']>,
  ): Promise<void> {
    const subdomain = this.extractSubdomain(req.headers.host, cfg.wildcardDomain);
    if (!subdomain) {
      this.sendHtml(req, res, 404, notFoundPage(), 'Sandbox not found');
      return;
    }

    // Reserved path: the waiting page polls it to learn when to reload. Served
    // before the upstream lookup so it keeps answering while nothing is
    // running — which is precisely when it is needed.
    if (this.isStatusRequest(req)) {
      await this.sendStatus(res, subdomain);
      return;
    }

    const entry = await this.registry.lookup(subdomain).catch(() => null);
    if (!entry) {
      await this.serveDormant(req, res, subdomain);
      return;
    }
    const upstream = {
      host: entry.upstreamHost,
      port: entry.upstreamPort,
      sandboxId: entry.sandboxId,
    };

    const headers = { ...req.headers };
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    delete headers['upgrade'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers['te'];
    delete headers['trailer'];

    const xff = req.headers['x-forwarded-for'];
    const remoteAddr = req.socket.remoteAddress ?? '';
    headers['x-forwarded-for'] = xff
      ? `${Array.isArray(xff) ? xff.join(', ') : xff}, ${remoteAddr}`
      : remoteAddr;
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] =
      (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    headers['x-devic-sandbox-id'] = upstream.sandboxId;

    const proxyReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
        timeout: cfg.upstreamTimeoutMs,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('upstream timeout'));
    });
    proxyReq.on('error', (err) => {
      this.logger.debug(
        `Upstream error (${upstream.host}:${upstream.port}): ${err.message}`,
      );
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Bad Gateway');
      } else {
        res.end();
      }
    });

    req.on('aborted', () => proxyReq.destroy());
    req.pipe(proxyReq);
  }

  /** Whether this request is the waiting page asking whether to reload. */
  private isStatusRequest(req: http.IncomingMessage): boolean {
    const path = (req.url ?? '').split('?')[0];
    return path === STATUS_PATH;
  }

  private async sendStatus(
    res: http.ServerResponse,
    subdomain: string,
  ): Promise<void> {
    const status = await this.wakeup
      .status(subdomain)
      .catch(() => ({ state: 'starting' as const }));
    const body = JSON.stringify(status);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  /**
   * Nothing is routing for this subdomain. Either a snapshot is behind it and
   * we wake it, or there is genuinely nothing here.
   */
  private async serveDormant(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    subdomain: string,
  ): Promise<void> {
    const outcome = await this.wakeup.wake(subdomain).catch((err) => {
      this.logger.warn(
        `Wake-up failed for ${subdomain}: ${(err as Error).message}`,
      );
      return { kind: 'unknown' as const };
    });

    switch (outcome.kind) {
      case 'unknown':
        this.sendHtml(req, res, 404, notFoundPage(), 'Sandbox not found');
        return;

      case 'disabled':
        // 503 rather than 404: the sandbox exists and could serve this address,
        // it is just not allowed to start itself.
        this.sendHtml(req, res, 503, disabledPage(), 'Sandbox is stopped');
        return;

      case 'waking':
      case 'already-waking': {
        const state = await this.wakeup
          .status(subdomain)
          .catch(() => ({ state: 'starting' as const }));
        if (state.state === 'ready') {
          // It came up between the lookup and now. Send the visitor round again
          // rather than making them watch a spinner for a live sandbox.
          res.statusCode = 307;
          res.setHeader('Location', req.url ?? '/');
          res.setHeader('Cache-Control', 'no-store');
          res.end();
          return;
        }
        if (state.state === 'error') {
          this.sendHtml(
            req,
            res,
            503,
            errorPage(state.message ?? ''),
            `Sandbox failed to start: ${state.message ?? ''}`,
          );
          return;
        }
        this.sendHtml(
          req,
          res,
          503,
          waitingPage({ timeoutSeconds: this.wakeup.timeoutSeconds }),
          'Sandbox is starting',
        );
        return;
      }
    }
  }

  /**
   * Serve a page to a browser, or a terse equivalent to anything else.
   *
   * A page load asks for far more than the document — assets, favicon, XHR — and
   * answering those with HTML would corrupt them. Only a request that says it
   * accepts HTML gets the page; everything else gets the status code and a
   * plain-text line, which is what the old behaviour always was.
   */
  private sendHtml(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    statusCode: number,
    html: string,
    plain: string,
  ): void {
    if (res.headersSent) return;
    res.statusCode = statusCode;
    res.setHeader('Cache-Control', 'no-store');
    if (statusCode === 503) res.setHeader('Retry-After', '5');

    const accept = String(req.headers['accept'] ?? '');
    if (!accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(plain);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    cfg: ReturnType<IngressProxyServer['resolved']>,
  ): Promise<void> {
    const upstream = await this.resolveUpstream(req, cfg.wildcardDomain);
    if (!upstream) {
      clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = net.connect(upstream.port, upstream.host, () => {
      const headerLines = [
        `${req.method} ${req.url} HTTP/${req.httpVersion}`,
        ...this.serializeHeaders(req.headers),
        '',
        '',
      ];
      upstreamSocket.write(headerLines.join('\r\n'));
      if (head && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    const closeBoth = () => {
      try {
        upstreamSocket.destroy();
      } catch {}
      try {
        clientSocket.destroy();
      } catch {}
    };
    upstreamSocket.on('error', closeBoth);
    clientSocket.on('error', closeBoth);
  }

  private serializeHeaders(headers: http.IncomingHttpHeaders): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) out.push(`${key}: ${v}`);
      } else {
        out.push(`${key}: ${value}`);
      }
    }
    return out;
  }
}
