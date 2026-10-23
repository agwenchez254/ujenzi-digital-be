import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SITE_DOCUMENT_MAX_BYTES } from './site-documents.types';
import { SiteDocumentsService } from './site-documents.service';

const RASTER_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

@ApiTags('Site documents')
@ApiBearerAuth()
@Controller('sites')
export class SiteDocumentsController {
  constructor(private documents: SiteDocumentsService) {}

  @ApiOperation({ summary: 'Download a site document (admins, engineers and people on the project)' })
  @Get('documents/:docId/file')
  async file(
    @Param('docId') docId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stream, fileName, mimeType, size } = await this.documents.getFile(docId, user);
    // Only raster images render inline; everything else is a download so an uploaded
    // file can never run as a page on our origin.
    const inline = RASTER_IMAGES.includes(mimeType);
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(stream as never);
  }

  @ApiOperation({ summary: 'List the documents attached to a site' })
  @Get(':id/documents')
  list(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.list(id, user);
  }

  @ApiOperation({
    summary: 'Attach or replace an approval document or the building plan (owner, linked developer or administrator)',
  })
  @ApiConsumes('multipart/form-data')
  @Roles('contractor', 'developer', 'administrator')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SITE_DOCUMENT_MAX_BYTES } }))
  @Post(':id/documents')
  upload(
    @Param('id') id: string,
    @Body('kind') kind: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.documents.upload(id, kind, file, user, ip);
  }

  @ApiOperation({ summary: 'Remove a site document' })
  @Roles('contractor', 'developer', 'administrator')
  @Delete('documents/:docId')
  remove(@Param('docId') docId: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.documents.remove(docId, user, ip);
  }
}
