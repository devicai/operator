import { Test, TestingModule } from '@nestjs/testing';
import * as http from 'http';
import { AddressInfo } from 'net';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { IngressProxyServer } from './ingress-proxy.server';
import { IngressRegistry } from './ingress-registry';
import { SandboxWakeupService } from './sandbox-wakeup.service';
import { SandboxRepository } from '../repositories/sandbox.repository';

/**
 * Exercises the proxy over a real socket, because what is being verified is
 * wire behaviour: status codes, content types and whether a browser gets HTML
 * where a script tag would get corrupted by it.
 */
describe('IngressProxyServer — dormant subdomains', () => {
  let proxy: IngressProxyServer;
  let port: number;

  const routes = new Map<string, any>();
  const registry = {
    lookup: jest.fn(async (sub: string) => routes.get(sub) ?? null),
    unpublish: jest.fn(async (sub: string) => {
      routes.delete(sub);
    }),
  };

  /** Sandbox documents the proxy may find when checking a route is still real. */
  const sandboxes = new Map<string, any>();
  const sandboxRepo = {
    findOne: jest.fn(async (filter: any) => sandboxes.get(filter.sandboxId) ?? null),
  };

  const wakeOutcomes = new Map<string, any>();
  const statuses = new Map<string, any>();
  const wakeup = {
    wake: jest.fn(async (sub: string) => wakeOutcomes.get(sub) ?? { kind: 'unknown' }),
    status: jest.fn(async (sub: string) => statuses.get(sub) ?? { state: 'idle' }),
    timeoutSeconds: 120,
  };

  const config = {
    ingress: {
      enabled: true,
      wildcardDomain: 'sandbox.devic.test',
      proxyPort: 0, // ephemeral: the OS picks a free port
      proxyHost: '127.0.0.1',
      defaultUpstreamPort: 80,
      upstreamTimeoutMs: 5000,
    },
  } as ModuleConfig;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IngressProxyServer,
        { provide: CONFIG, useValue: config },
        { provide: IngressRegistry, useValue: registry },
        { provide: SandboxWakeupService, useValue: wakeup },
        { provide: SandboxRepository, useValue: sandboxRepo },
      ],
    }).compile();
    proxy = moduleRef.get(IngressProxyServer);
    await proxy.onModuleInit();
    port = ((proxy as any).server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await proxy.onModuleDestroy();
  });

  beforeEach(() => {
    routes.clear();
    sandboxes.clear();
    wakeOutcomes.clear();
    statuses.clear();
    jest.clearAllMocks();
  });

  const get = (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { host: 'my-app.sandbox.devic.test', ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

  const BROWSER = { accept: 'text/html,application/xhtml+xml' };

  it('serves the waiting page to a browser while a sandbox is starting', async () => {
    wakeOutcomes.set('my-app', { kind: 'waking', snapshot: {} });
    statuses.set('my-app', { state: 'starting' });

    const res = await get('/', BROWSER);

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toContain('Starting this sandbox');
  });

  // A page load also requests assets. Answering those with HTML would corrupt
  // them, so only a client that asks for HTML gets the page.
  it('serves plain text to a non-browser client', async () => {
    wakeOutcomes.set('my-app', { kind: 'waking', snapshot: {} });
    statuses.set('my-app', { state: 'starting' });

    const res = await get('/app.js', { accept: '*/*' });

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('Sandbox is starting');
  });

  it('answers the status endpoint even with nothing running', async () => {
    statuses.set('my-app', { state: 'starting', elapsedSeconds: 4 });

    const res = await get('/__devic/status');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({ state: 'starting', elapsedSeconds: 4 });
    // It must never be mistaken for a wake-up trigger.
    expect(wakeup.wake).not.toHaveBeenCalled();
  });

  it('tells the visitor when auto-restart is switched off', async () => {
    wakeOutcomes.set('my-app', { kind: 'disabled', snapshot: {} });

    const res = await get('/', BROWSER);

    expect(res.status).toBe(503);
    expect(res.body).toContain('Automatic restart is turned off');
  });

  it('404s when the subdomain matches nothing', async () => {
    wakeOutcomes.set('my-app', { kind: 'unknown' });

    const res = await get('/', BROWSER);

    expect(res.status).toBe(404);
    expect(res.body).toContain('Nothing is served here');
  });

  it('surfaces a failed wake-up instead of a spinner', async () => {
    wakeOutcomes.set('my-app', { kind: 'already-waking', snapshot: {} });
    statuses.set('my-app', { state: 'error', message: 'not enough memory' });

    const res = await get('/', BROWSER);

    expect(res.status).toBe(503);
    expect(res.body).toContain('not enough memory');
  });

  // The sandbox can finish starting between the registry miss and the reply.
  it('redirects instead of waiting when the sandbox came up meanwhile', async () => {
    wakeOutcomes.set('my-app', { kind: 'already-waking', snapshot: {} });
    statuses.set('my-app', { state: 'ready' });

    const res = await get('/deep/link?q=1', BROWSER);

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('/deep/link?q=1');
  });

  it('404s a host outside the wildcard domain without trying to wake anything', async () => {
    const res = await get('/', { host: 'example.com', ...BROWSER });

    expect(res.status).toBe(404);
    expect(wakeup.wake).not.toHaveBeenCalled();
  });

  it('proxies normally when a route exists, never reaching the wake path', async () => {
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('hello from the sandbox');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    routes.set('my-app', {
      sandboxId: 'box1',
      upstreamHost: '127.0.0.1',
      upstreamPort,
    });

    try {
      const res = await get('/', BROWSER);
      expect(res.status).toBe(200);
      expect(res.body).toBe('hello from the sandbox');
      expect(wakeup.wake).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  // Nothing answering at an address means one of two very different things, and
  // the sandbox record is what tells them apart.
  describe('when nothing answers at the routed address', () => {
    // Port 1 on loopback: nothing binds it, so connecting is refused at once.
    const silentRoute = (sandboxId: string) =>
      routes.set('my-app', {
        sandboxId,
        upstreamHost: '127.0.0.1',
        upstreamPort: 1,
      });

    // The route outlived what it pointed at. Left in place it is worse than no
    // route at all: a route suppresses the wake-up that would replace it, so
    // the address stays dead until the sandbox expires.
    it('drops the route and wakes the snapshot when the sandbox is gone', async () => {
      silentRoute('goneBox');
      wakeOutcomes.set('my-app', { kind: 'waking', snapshot: {} });
      statuses.set('my-app', { state: 'starting' });

      const res = await get('/', BROWSER);

      expect(registry.unpublish).toHaveBeenCalledWith('my-app');
      expect(wakeup.wake).toHaveBeenCalledWith('my-app');
      expect(res.status).toBe(503);
      expect(res.body).toContain('Starting this sandbox');
    });

    it('reports 404 when there is no snapshot to fall back on', async () => {
      silentRoute('goneBox');
      wakeOutcomes.set('my-app', { kind: 'unknown' });

      const res = await get('/', BROWSER);

      expect(registry.unpublish).toHaveBeenCalledWith('my-app');
      expect(res.status).toBe(404);
    });

    // A live sandbox with nothing listening is the normal state right after a
    // restore — snapshots restore files, not processes. Replacing it would
    // abandon a sandbox someone may be working in AND leave two linked
    // sandboxes of one snapshot racing to write themselves back into it.
    it('keeps the route when the sandbox is running but silent', async () => {
      silentRoute('liveBox');
      sandboxes.set('liveBox', { sandboxId: 'liveBox', status: 'running' });

      const res = await get('/', BROWSER);

      expect(registry.unpublish).not.toHaveBeenCalled();
      expect(wakeup.wake).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      // The waiting page reloads the moment anything starts listening.
      expect(res.body).toContain('Starting this sandbox');
    });

    it('drops the route when the sandbox exists but has stopped', async () => {
      silentRoute('stoppedBox');
      sandboxes.set('stoppedBox', { sandboxId: 'stoppedBox', status: 'stopped' });
      wakeOutcomes.set('my-app', { kind: 'waking', snapshot: {} });
      statuses.set('my-app', { state: 'starting' });

      await get('/', BROWSER);

      expect(registry.unpublish).toHaveBeenCalledWith('my-app');
    });
  });

  // An upstream that accepts the connection and then misbehaves is the
  // upstream's own problem: dropping its route would replace a running sandbox
  // over a bad response.
  it('keeps a 502 for an upstream that answers badly', async () => {
    const upstream = http.createServer((_req, socket) => {
      socket.destroy();
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    routes.set('my-app', {
      sandboxId: 'box1',
      upstreamHost: '127.0.0.1',
      upstreamPort,
    });

    try {
      const res = await get('/', BROWSER);
      expect(res.status).toBe(502);
      expect(registry.unpublish).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});
