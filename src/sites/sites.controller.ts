import { Body, Controller, Delete, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AddSitePersonnelDto } from './dto/add-site-personnel.dto';
import { CreateSiteDto } from './dto/create-site.dto';
import { SetPublicSharingDto } from './dto/set-public-sharing.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SitesService } from './sites.service';

@ApiTags('Sites')
@ApiBearerAuth()
@Controller('sites')
export class SitesController {
  constructor(private sitesService: SitesService) {}

  @ApiOperation({ summary: 'List sites (all sites for administrators, tied sites for everyone else)' })
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.sitesService.findAll(user);
  }

  @ApiOperation({ summary: 'List map pins (all sites for administrators, tied sites for everyone else)' })
  @Get('map')
  findMapPins(@CurrentUser() user: AuthenticatedUser) {
    return this.sitesService.findMapPins(user);
  }

  @ApiOperation({ summary: 'List sites deleted in the last 30 days, which can still be restored (administrators)' })
  @Roles('administrator')
  @Get('deleted')
  findDeleted() {
    return this.sitesService.findDeleted();
  }

  @ApiOperation({ summary: 'Get a site by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sitesService.findOne(id);
  }

  @ApiOperation({ summary: 'Create a site (contractor for self, developer via a linked contractor in personnel, or administrator for any contractor)' })
  @Roles('contractor', 'developer', 'administrator')
  @Post()
  create(@Body() dto: CreateSiteDto, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.sitesService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Update a site (owning contractor, a linked developer, or administrator)' })
  @Roles('contractor', 'developer', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.sitesService.update(id, dto, user, ip);
  }

  @ApiOperation({
    summary:
      'Delete a site (owning contractor or administrator). Soft delete: contents are kept for 30 days. ' +
      'A site with inspections in progress can only be deleted by an administrator.',
  })
  @Roles('contractor', 'administrator')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.sitesService.remove(id, user, ip);
  }

  @ApiOperation({ summary: 'Restore a deleted site within its 30 day retention window (administrators)' })
  @Roles('administrator')
  @Post(':id/restore')
  async restore(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    await this.sitesService.restore(id, user, ip);
    return { success: true };
  }

  @ApiOperation({
    summary:
      'Add personnel to a site (add-only — any contractor or developer already tied to the site, or an ' +
      'administrator; does not affect existing entries or any other site field)',
  })
  @Roles('contractor', 'developer', 'administrator')
  @Post(':id/personnel')
  addPersonnel(
    @Param('id') id: string,
    @Body() dto: AddSitePersonnelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.sitesService.addPersonnel(id, dto.personnel, user, ip);
  }

  @ApiOperation({
    summary:
      'Enable or disable the public share page for a site (owning contractor, a linked developer, or administrator). ' +
      'The public page at /public/sites/:id 404s for any site this has never been enabled on.',
  })
  @Patch(':id/sharing')
  async setPublicSharing(
    @Param('id') id: string,
    @Body() dto: SetPublicSharingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    await this.sitesService.setPublicSharing(id, dto.enabled, user, ip);
    return { isPubliclyShared: dto.enabled };
  }
}
