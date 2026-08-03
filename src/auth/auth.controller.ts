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
import { AllowNoRole } from '../common/decorators/allow-no-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CsrfService } from '../common/csrf/csrf.service';
import { AuthService } from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import type { GoogleProfile } from './strategies/google.strategy';
import type { AuthenticatedUser } from './types/jwt-payload.type';

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

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard redirects to Google's consent screen; no body to return.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  googleCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.loginWithGoogle(req.user as GoogleProfile, res);
  }

  @AllowNoRole()
  @Post('complete-profile')
  completeProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteProfileDto,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    return this.authService.completeProfile(user.userId, dto, res, ip);
  }
}
