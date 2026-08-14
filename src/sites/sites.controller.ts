import { Body, Controller, Delete, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SitesService } from './sites.service';

@ApiTags('Sites')
@ApiBearerAuth()
@Controller('sites')
export class SitesController {
  constructor(private sitesService: SitesService) {}

  @ApiOperation({ summary: 'List all sites' })
  @Get()
  findAll() {
    return this.sitesService.findAll();
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

  @ApiOperation({ summary: 'Delete a site (owning contractor or administrator)' })
  @Roles('contractor', 'administrator')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.sitesService.remove(id, user, ip);
  }
}
