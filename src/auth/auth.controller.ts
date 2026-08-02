import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
  Get,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CsrfService } from '../common/csrf/csrf.service';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';

@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private csrfService: CsrfService,
  ) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response, @Ip() ip: string) {
    return this.authService.signup(dto, res, ip);
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(req.user as User, res);
  }

  @Public()
  @Get('csrf-token')
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrfService.generateToken(req, res) };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.refresh(req.cookies?.['refreshToken'], res);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.['refreshToken'], res);
    return { success: true };
  }
}
