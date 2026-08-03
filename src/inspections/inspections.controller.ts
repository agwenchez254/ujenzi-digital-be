import { Body, Controller, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { SubmitInspectionDto } from './dto/submit-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { InspectionsService } from './inspections.service';

@ApiTags('Inspections')
@ApiBearerAuth()
@Controller('inspections')
export class InspectionsController {
  constructor(private inspectionsService: InspectionsService) {}

  @ApiOperation({ summary: 'List all inspections' })
  @Get()
  findAll() {
    return this.inspectionsService.findAll();
  }

  @ApiOperation({ summary: 'Get an inspection by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.inspectionsService.findOne(id);
  }

  @ApiOperation({ summary: 'Start an inspection from an accepted request (assigned engineer or administrator)' })
  @Roles('engineer', 'administrator')
  @Post()
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.inspectionsService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Save checklist progress on an in-progress inspection (owning engineer or administrator)' })
  @Roles('engineer', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionsService.update(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Submit a finished inspection and complete its inspection request' })
  @Roles('engineer', 'administrator')
  @Post(':id/submit')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionsService.submit(id, dto, user, ip);
  }
}
