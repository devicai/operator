import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Inject,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.auth?.enabled || this.config.auth.strategy !== 'api-key') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const path: string = req.path ?? req.url ?? '';

    if (path.startsWith('/health')) return true;

    const apiKey = this.extractApiKey(req);
    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    const validKeys = this.config.auth.apiKeys ?? [];
    const isValid = validKeys.some((k) => k.key === apiKey);
    if (!isValid) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }

  private extractApiKey(req: any): string | null {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    const xApiKey = req.headers['x-api-key'];
    if (xApiKey) return xApiKey;

    return null;
  }
}
