export interface ModuleConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  microsandbox: MicrosandboxConfig;
  mcp: McpConfig;
  extensions: ExtensionsConfig;
  auth: AuthConfig;
  webhooks?: WebhooksConfig;
  logging: LoggingConfig;
}

export interface ServerConfig {
  port: number;
  basePath: string;
  cors?: {
    enabled: boolean;
    origins: string[];
  };
}

export interface DatabaseConfig {
  provider: 'mongodb';
  uri?: string;
}

export interface RedisConfig {
  url: string;
}

export interface MicrosandboxConfig {
  defaultImage: string;
  defaultCpus: number;
  defaultMemoryMib: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  ttlCheckIntervalMs: number;
}

export interface McpConfig {
  enabled: boolean;
  path?: string;
}

export interface ExtensionsConfig {
  properties: ExtensionProperty[];
}

export interface ExtensionProperty {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required: boolean;
  index: boolean;
  entities: string[] | '*';
  source: 'header';
  headerName: string;
}

export interface AuthConfig {
  enabled: boolean;
  strategy: 'api-key' | 'jwt' | 'none';
  apiKeys?: Array<{
    name: string;
    key: string;
  }>;
}

export interface WebhooksConfig {
  events: Record<string, string>;
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}
