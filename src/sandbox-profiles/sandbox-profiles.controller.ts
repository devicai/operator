import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SandboxProfilesService } from './sandbox-profiles.service';
import { CreateSandboxProfileDto } from './dto/create-sandbox-profile.dto';
import { UpdateSandboxProfileDto } from './dto/update-sandbox-profile.dto';

@ApiTags('Sandbox Profiles')
@Controller('sandbox-profiles')
export class SandboxProfilesController {
  constructor(private readonly service: SandboxProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'List sandbox profiles' })
  findAll(
    @Req() req: any,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    const scope = req.extensionScope ?? {};
    return this.service.findAll(scope, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sandbox profile by ID' })
  findById(@Param('id') id: string, @Req() req: any) {
    return this.service.findById(id, req.extensionScope ?? {});
  }

  @Post()
  @ApiOperation({ summary: 'Create sandbox profile' })
  create(@Body() dto: CreateSandboxProfileDto, @Req() req: any) {
    return this.service.create(dto, req.extensionScope ?? {});
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update sandbox profile' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSandboxProfileDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.extensionScope ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete sandbox profile' })
  delete(@Param('id') id: string, @Req() req: any) {
    return this.service.delete(id, req.extensionScope ?? {});
  }
}
