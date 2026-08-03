import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

interface HttpErrorLike {
  status?: number;
  statusCode?: number;
  message?: string;
}

function isHttpErrorLike(exception: unknown): exception is HttpErrorLike {
  if (typeof exception !== 'object' || exception === null) {
    return false;
  }
  const status = (exception as HttpErrorLike).status ?? (exception as HttpErrorLike).statusCode;
  return typeof status === 'number' && status >= 400 && status < 600;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : ((exceptionResponse as { message?: string | string[] }).message ??
            'Internal server error');

      const error =
        typeof exceptionResponse === 'object'
          ? ((exceptionResponse as { error?: string }).error ?? HttpStatus[statusCode])
          : HttpStatus[statusCode];

      response.status(statusCode).json({ statusCode, message, error });
      return;
    }

    if (isHttpErrorLike(exception)) {
      const statusCode = (exception.status ?? exception.statusCode)!;
      response.status(statusCode).json({
        statusCode,
        message: exception.message ?? 'Error',
        error: HttpStatus[statusCode] ?? 'Error',
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: HttpStatus[HttpStatus.INTERNAL_SERVER_ERROR],
    });
  }
}
