import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CsrfService } from './csrf.service';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private csrfService: CsrfService) {}

  use(req: Request, res: Response, next: NextFunction) {
    this.csrfService.protect(req, res, next);
  }
}
