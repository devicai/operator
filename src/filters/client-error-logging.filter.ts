import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Logs every rejected request before handing it back to Nest's default filter.
 *
 * Nest logs 5xx and lets 4xx through in silence. That silence is expensive here:
 * a client of this API (the SuntropyAI backend) treats a failed create as
 * "provider could not allocate" and quietly falls back to another provider, so a
 * rejection nobody logged looks exactly like a healthy day — the caller ends up
 * on the fallback provider and the operator has no record of why. It cost a full
 * investigation to find out that an auth rejection and a validation rejection
 * both leave no trace at all.
 *
 * 5xx keeps its stack; 4xx is a one-liner, since the client's mistake is the
 * message, not our call stack.
 */
@Catch()
export class ClientErrorLoggingFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;

    if (status >= 400 && status < 500) {
      const method: string = req?.method ?? '?';
      const path: string = req?.originalUrl ?? req?.url ?? '?';
      const response =
        exception instanceof HttpException
          ? exception.getResponse()
          : undefined;
      // Validation errors arrive as { message: string[] }; flatten so the whole
      // reason fits on the line instead of printing "[object Object]".
      const detail =
        typeof response === 'string'
          ? response
          : Array.isArray((response as any)?.message)
            ? (response as any).message.join('; ')
            : ((response as any)?.message ??
              (exception as Error)?.message ??
              'unknown');

      this.logger.warn(`${method} ${path} -> ${status} ${detail}`);
    }

    super.catch(exception, host);
  }
}
