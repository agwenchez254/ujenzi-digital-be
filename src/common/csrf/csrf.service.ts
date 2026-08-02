import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import { Request, Response } from 'express';

@Injectable()
export class CsrfService {
  private readonly utils: ReturnType<typeof doubleCsrf>;

  constructor(configService: ConfigService) {
    this.utils = doubleCsrf({
      getSecret: () => configService.get<string>('CSRF_SECRET')!,
      getSessionIdentifier: (req) => req.cookies?.['refreshToken'] ?? '',
      cookieName: 'csrfToken',
      cookieOptions: {
        sameSite: 'lax',
        path: '/auth',
        secure: configService.get<string>('NODE_ENV') === 'production',
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
