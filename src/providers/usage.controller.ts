import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ResourceUsageService } from './resource-usage.service';

@ApiTags('Usage')
@Controller('usage')
export class UsageController {
  constructor(private readonly resourceUsage: ResourceUsageService) {}

  @Get()
  @ApiOperation({
    summary: 'Module-wide resource usage',
    description:
      'Returns aggregated RAM and disk usage across all sandboxes/snapshots, ' +
      'along with the configured limits (or null if unlimited).',
  })
  getUsage() {
    return this.resourceUsage.getUsageSummary();
  }
}
