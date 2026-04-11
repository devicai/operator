import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';

@Injectable()
export class ExtensionScopeInterceptor implements NestInterceptor {
  constructor(
    @Inject(EXTENSIONS_TOKEN)
    private readonly extensions: ExtensionProperty[],
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const scope: Record<string, string> = {};

    for (const ext of this.extensions) {
      const headerValue = req.headers[ext.headerName.toLowerCase()];

      if (ext.required && !headerValue) {
        const res = context.switchToHttp().getResponse();
        res.status(400).json({
          statusCode: 400,
          error: 'Bad Request',
          message: `Missing required header: ${ext.headerName}`,
          details: {
            header: ext.headerName,
            extension: ext.name,
          },
        });
        return new Observable((subscriber) => subscriber.complete());
      }

      if (headerValue) {
        scope[ext.name] = headerValue;
      }
    }

    req.extensionScope = scope;
    return next.handle();
  }
}
