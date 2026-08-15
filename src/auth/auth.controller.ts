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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { AllowNoRole } from '../common/decorators/allow-no-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CsrfService } from '../common/csrf/csrf.service';
import { AuthService } from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import type { GoogleProfile } from './strategies/google.strategy';
import type { AuthenticatedUser } from './types/jwt-payload.type';

@ApiTags('Auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private csrfService: CsrfService,
  ) {}

  @ApiOperation({ summary: 'Sign up with email/password; roles are active immediately' })
  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response, @Ip() ip: string) {
    return this.authService.signup(dto, res, ip);
  }

  @ApiOperation({ summary: 'Log in with email/password' })
  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(req.user as User, res);
  }

  @ApiOperation({ summary: 'Get a CSRF token for the refresh/logout double-submit cookie' })
  @Public()
  @Get('csrf-token')
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrfService.generateToken(req, res) };
  }

  @ApiOperation({ summary: 'Rotate the refresh token and issue a fresh access token (requires x-csrf-token)' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.refresh(req.cookies?.['refreshToken'], res);
  }

  @ApiOperation({ summary: 'Revoke the current refresh token (requires x-csrf-token)' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.['refreshToken'], res);
    return { success: true };
  }

  @ApiOperation({ summary: 'Request a password reset link by email (always returns success, regardless of whether the email exists)' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: RequestPasswordResetDto) {
    await this.authService.requestPasswordReset(dto.email);
    return { success: true };
  }

  @ApiOperation({ summary: 'Reset a password using the token emailed by /auth/forgot-password' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  @ApiOperation({ summary: "Redirect to Google's OAuth consent screen" })
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard redirects to Google's consent screen; no body to return.
  }

  @ApiOperation({ summary: 'Google OAuth callback; returns needsRoleSelection: true for first-time logins' })
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  googleCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.loginWithGoogle(req.user as GoogleProfile, res);
  }

  @ApiOperation({ summary: 'Set initial role(s) for a zero-role Google account' })
  @ApiBearerAuth()
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
