import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import { Request, Response } from 'express';

@Injectable()
export class CsrfService {
  private readonly utils: ReturnType<typeof doubleCsrf>;

  constructor(configService: ConfigService) {
    // Same cross-site reasoning as the refreshToken cookie in auth.service.ts:
    // in production the frontend and backend are different domains, so this
    // needs SameSite=None (+ Secure) to actually reach the backend on a
    // cross-site fetch/XHR call at all.
    const isProduction = configService.get<string>('NODE_ENV') === 'production';
    this.utils = doubleCsrf({
      getSecret: () => configService.get<string>('CSRF_SECRET')!,
      getSessionIdentifier: (req) => req.cookies?.['refreshToken'] ?? '',
      cookieName: 'csrfToken',
      cookieOptions: {
        sameSite: isProduction ? 'none' : 'lax',
        path: '/auth',
        secure: isProduction,
        httpOnly: true,
      },
      getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
    });
  }

  generateToken(req: Request, res: Response): string {
    return this.utils.generateCsrfToken(req, res);
  }

  get protect() {
    return this.utils.doubleCsrfProtection;
  }
}
