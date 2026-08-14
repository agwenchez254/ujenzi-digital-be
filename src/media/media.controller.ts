import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MediaService } from './media.service';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

@ApiTags('Media')
@ApiBearerAuth()
@Controller()
export class MediaController {
  constructor(private mediaService: MediaService) {}

  @ApiOperation({ summary: 'List all media for an inspection (tied users, the assigned engineer, or an administrator)' })
  @Get('inspections/:inspectionId/media')
  findAllForInspection(@Param('inspectionId') inspectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.mediaService.findAllForInspection(inspectionId, user);
  }

  @ApiOperation({ summary: 'Upload a photo or video to an in-progress inspection (owning engineer or administrator)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        caption: { type: 'string' },
      },
      required: ['file', 'latitude', 'longitude'],
    },
  })
  @Roles('engineer', 'administrator')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        if (!/^(image|video)\//.test(file.mimetype)) {
          callback(new UnsupportedMediaTypeException('Only image or video uploads are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  @Post('inspections/:inspectionId/media')
  upload(
    @Param('inspectionId') inspectionId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadMediaDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.mediaService.upload(inspectionId, file, dto, user, ip);
  }

  @ApiOperation({ summary: 'Stream a media file (tied users, the assigned engineer, or an administrator)' })
  @Get('media/:id/file')
  async getFile(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    const { stream, extension } = await this.mediaService.getFileStream(id, user);
    res.set('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ statusCode: 404, message: 'Media file not found', error: 'Not Found' });
      }
    });
    stream.pipe(res);
  }

  @ApiOperation({ summary: 'Delete a media item (owning engineer or administrator)' })
  @Roles('engineer', 'administrator')
  @Delete('media/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.mediaService.remove(id, user, ip);
  }
}
