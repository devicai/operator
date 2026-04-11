import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { ModuleConfig } from './config.types';

const ENV_VAR_PATTERN = /\$\{([^}:-]+)(?::-(.*?))?\}/g;

function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName: string, defaultValue?: string) => {
    return process.env[varName] ?? defaultValue ?? '';
  });
}

function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVarsDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath?: string): ModuleConfig {
  const path = configPath ?? join(process.cwd(), 'config.yml');

  if (!existsSync(path)) {
    throw new Error(
      `Configuration file not found: ${path}\n` +
        'Copy config.example.yml to config.yml and adjust to your environment.',
    );
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const resolved = resolveEnvVarsDeep(parsed) as ModuleConfig;

  // Apply defaults
  resolved.extensions = resolved.extensions ?? { properties: [] };
  resolved.logging = resolved.logging ?? { level: 'info', format: 'json' };
  resolved.auth = resolved.auth ?? { enabled: false, strategy: 'none' };
  resolved.redis = resolved.redis ?? { url: 'redis://localhost:6379' };
  resolved.microsandbox = resolved.microsandbox ?? {
    defaultImage: 'node:24',
    defaultCpus: 1,
    defaultMemoryMib: 256,
    defaultTtlSeconds: 1800,
    maxTtlSeconds: 7200,
    ttlCheckIntervalMs: 30000,
  };
  resolved.mcp = resolved.mcp ?? { enabled: true };

  return resolved;
}

export const CONFIG = Symbol('MODULE_CONFIG');
