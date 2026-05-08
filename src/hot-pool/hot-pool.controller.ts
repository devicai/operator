import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HotPoolService } from './hot-pool.service';
import { UpdateHotPoolDto } from './dto/update-hot-pool.dto';
import { ClaimHotDto } from './dto/claim-hot.dto';

@ApiTags('Hot Pool')
@Controller('hot-pool')
export class HotPoolController {
  constructor(private readonly hotPool: HotPoolService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Hot pool status, config and live metrics',
  })
  status() {
    return this.hotPool.getStatus();
  }

  @Put('config')
  @ApiOperation({
    summary: 'Update hot pool configuration (persisted, applied immediately)',
  })
  updateConfig(@Body() dto: UpdateHotPoolDto) {
    return this.hotPool.updateConfig(dto);
  }

  @Post('claim')
  @ApiOperation({
    summary:
      'Claim a pre-warmed sandbox from the pool. Returns the sandbox ' +
      'document ready to receive commands; refills the slot in the background.',
  })
  claim(@Body() dto: ClaimHotDto) {
    return this.hotPool.claim(dto ?? {});
  }

  @Post('reconcile')
  @ApiOperation({
    summary: 'Force a reconcile pass (provision missing pods, drain extras)',
  })
  reconcile() {
    return this.hotPool.forceReconcile();
  }
}
