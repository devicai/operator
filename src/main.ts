import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, LogLevel } from '@nestjs/common';
import { json } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { loadConfig } from './config/config.loader';
import { ClientErrorLoggingFilter } from './filters/client-error-logging.filter';

/** Nest's log levels, least to most severe. */
const LOG_LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

/**
 * Expand `logging.level` into every level at or above it.
 *
 * The configured level is a *threshold*, not a single channel: asking for
 * `debug` means "debug and everything more severe". Passing the level verbatim
 * enabled exactly that one plus error/warn, so `level: debug` — the setting
 * most deployments run — dropped every `logger.log()`, taking the boot banner,
 * sandbox expiry and hot pool activity with it.
 */
function resolveLogLevels(level?: string): LogLevel[] {
  const index = level ? LOG_LEVELS.indexOf(level as LogLevel) : -1;
  if (index === -1) return LOG_LEVELS.slice(LOG_LEVELS.indexOf('log'));
  return LOG_LEVELS.slice(index);
}

async function bootstrap() {
  const config = loadConfig();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: resolveLogLevels(config.logging?.level),
  });

  // WebSocket adapter
  app.useWebSocketAdapter(new WsAdapter(app));

  // Body size limit for file uploads
  app.use(json({ limit: '10mb' }));

  // Global prefix
  const basePath = config.server.basePath ?? '/api/v1';
  app.setGlobalPrefix(basePath, { exclude: ['health', 'health/ready'] });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Registered after the pipe so the rejections it raises are logged too: a
  // request refused for a bad body is exactly the kind of failure that used to
  // vanish without a line.
  app.useGlobalFilters(new ClientErrorLoggingFilter(app.getHttpAdapter()));

  // CORS
  if (config.server.cors?.enabled) {
    app.enableCors({
      origin: config.server.cors.origins,
    });
  }

  // Swagger / OpenAPI
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Operator')
    .setDescription('Operator — sandbox orchestration API (microsandbox/Docker abstraction layer)')
    .setVersion(process.env.npm_package_version ?? '0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${basePath}/docs`, app, document);

  // Start
  const port = config.server.port ?? 3200;
  await app.listen(port);

  logger.log(`Service running on port ${port}`);
  logger.log(`API docs: http://localhost:${port}${basePath}/docs`);
  logger.log(`MCP endpoint: http://localhost:${port}${basePath}/mcp`);
  logger.log(`Terminal WS: ws://localhost:${port}/ws/terminal`);

  if (config.extensions.properties.length > 0) {
    const extNames = config.extensions.properties.map((e) => e.name).join(', ');
    logger.log(`Entity extensions active: ${extNames}`);
  } else {
    logger.log('No entity extensions configured (standalone mode)');
  }
}

bootstrap();
