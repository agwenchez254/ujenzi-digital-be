import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

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
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const describe = (msg: unknown) =>
      Array.isArray(msg) ? msg.join('; ') : String(msg ?? 'Unknown error');
    const stash = (msg: unknown) => {
      response.locals.error = { message: describe(msg) };
    };
    const logUnexpected = (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `[${response.locals.requestId ?? '-'}] ${request.method} ${request.originalUrl} → ${e.name}: ${e.message}`,
        e.stack,
      );
    };

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : ((exceptionResponse as { message?: string | string[] }).message ??
            'Internal server error');

      stash(message);
      if (statusCode >= 500) logUnexpected(exception);

      const error =
        typeof exceptionResponse === 'object'
          ? ((exceptionResponse as { error?: string }).error ?? HttpStatus[statusCode])
          : HttpStatus[statusCode];

      response.status(statusCode).json({ statusCode, message, error });
      return;
    }

    if (isHttpErrorLike(exception)) {
      const statusCode = (exception.status ?? exception.statusCode)!;
      stash(exception.message);
      if (statusCode >= 500) logUnexpected(exception);
      response.status(statusCode).json({
        statusCode,
        message: exception.message ?? 'Error',
        error: HttpStatus[statusCode] ?? 'Error',
      });
      return;
    }

    stash(exception instanceof Error ? exception.message : exception);
    logUnexpected(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: HttpStatus[HttpStatus.INTERNAL_SERVER_ERROR],
    });
  }
}
