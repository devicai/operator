import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Basic health check' })
  health() {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check (database connectivity)' })
  ready() {
    const dbReady = this.connection.readyState === 1;

    return {
      status: dbReady ? 'ready' : 'not_ready',
      database: dbReady ? 'connected' : 'disconnected',
    };
  }
}
