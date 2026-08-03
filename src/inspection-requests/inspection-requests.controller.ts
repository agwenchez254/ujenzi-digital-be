import { Body, Controller, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AcceptInspectionRequestDto } from './dto/accept-inspection-request.dto';
import { CreateInspectionRequestDto } from './dto/create-inspection-request.dto';
import { UpdateInspectionRequestDto } from './dto/update-inspection-request.dto';
import { InspectionRequestsService } from './inspection-requests.service';

@ApiTags('InspectionRequests')
@ApiBearerAuth()
@Controller('inspection-requests')
export class InspectionRequestsController {
  constructor(private inspectionRequestsService: InspectionRequestsService) {}

  @ApiOperation({ summary: 'List inspection requests (contractors see only their own; engineers/admins see all)' })
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.inspectionRequestsService.findAll(user);
  }

  @ApiOperation({ summary: 'Get an inspection request by id' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inspectionRequestsService.findOne(id, user);
  }

  @ApiOperation({ summary: 'Create an inspection request (contractor for self, or administrator for any contractor)' })
  @Roles('contractor', 'administrator')
  @Post()
  create(
    @Body() dto: CreateInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Update an inspection request (owning contractor while pending, or administrator anytime)' })
  @Roles('contractor', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.update(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Accept a pending inspection request (engineer for self, or administrator for any engineer)' })
  @Roles('engineer', 'administrator')
  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.accept(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Reject a pending inspection request' })
  @Roles('engineer', 'administrator')
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.inspectionRequestsService.reject(id, user, ip);
  }
}
