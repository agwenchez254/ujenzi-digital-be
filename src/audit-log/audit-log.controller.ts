import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@ApiTags('AuditLog')
@ApiBearerAuth()
@Roles('administrator')
@Controller('audit-logs')
export class AuditLogController {
  constructor(private auditLogService: AuditLogService) {}

  @ApiOperation({ summary: 'List audit log entries, filterable by entity/user/date (administrator only)' })
  @Get()
  findMany(@Query() query: QueryAuditLogDto) {
    return this.auditLogService.findMany(query);
  }
}
