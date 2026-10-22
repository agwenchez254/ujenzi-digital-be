import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'https://api.mapbox.com'],
        },
      },
    }),
  );
  app.use(cookieParser());

  const rawOrigins = configService.get<string>('FRONTEND_ORIGIN');
  const allowedOrigins = rawOrigins
    ? rawOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
    : [
      'http://localhost:8080',
      'http://localhost:8081',
      'http://localhost:5173',
      'http://localhost:3000',
    ];

  // Always allow localhost:8080 and localhost:5173 for local development
  if (!allowedOrigins.includes('http://localhost:8080')) {
    allowedOrigins.push('http://localhost:8080');
  }
  if (!allowedOrigins.includes('http://localhost:5173')) {
    allowedOrigins.push('http://localhost:5173');
  }

  if (!allowedOrigins.includes('http://localhost:8081')) {
    allowedOrigins.push('http://localhost:8081');
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-csrf-token',
      'X-Requested-With',
      'Accept',
    ],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ujenzi Digital API')
    .setDescription(
      'Errors are normalized to { statusCode, message, error } by a global exception filter. ' +
      'Most routes require a Bearer access token; /auth/refresh and /auth/logout additionally ' +
      'require an x-csrf-token header (see GET /auth/csrf-token).',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = configService.get<number>('PORT') ?? 5000;
  await app.listen(port);
}
bootstrap();
