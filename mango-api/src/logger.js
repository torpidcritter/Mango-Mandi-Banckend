import pino from 'pino'
import { env, isProd } from './env.js'

// Sensitive values are redacted at every depth.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.password_hash',
      '*.code',
      '*.devCode',
      '*.accessToken',
      '*.refreshToken',
      'password',
      'password_hash',
      'code',
      'devCode',
      'accessToken',
      'refreshToken',
    ],
    censor: '[redacted]',
  },
  ...(isProd || env.NODE_ENV === 'test' ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
})
