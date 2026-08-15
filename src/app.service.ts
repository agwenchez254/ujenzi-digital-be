import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello there, you have reached Ujenzi Digital API! Your constructions works made easy.';
  }
}
