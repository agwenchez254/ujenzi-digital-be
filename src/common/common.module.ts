import { Global, Module } from '@nestjs/common';
import { CsrfMiddleware } from './csrf/csrf.middleware';
import { CsrfService } from './csrf/csrf.service';

@Global()
@Module({
  providers: [CsrfService, CsrfMiddleware],
  exports: [CsrfService],
})
export class CommonModule {}
