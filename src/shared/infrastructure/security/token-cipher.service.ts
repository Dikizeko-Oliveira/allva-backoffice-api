import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1:';
const SCRYPT_SALT = 'allva-integration-token-cipher';

@Injectable()
export class TokenCipherService implements OnModuleInit {
  private readonly logger = new Logger(TokenCipherService.name);
  private key!: Buffer;

  constructor(private readonly envService: EnvService) {}

  onModuleInit(): void {
    const secret = this.envService.get('INTEGRATION_TOKEN_ENCRYPTION_KEY');
    this.key = scryptSync(secret, SCRYPT_SALT, KEY_LENGTH);
  }

  encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error('Cannot encrypt empty token');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${VERSION_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(payload: string): string {
    if (!payload) {
      throw new Error('Cannot decrypt empty payload');
    }

    if (!payload.startsWith(VERSION_PREFIX)) {
      this.logger.warn(
        'Decrypting legacy plaintext token; will be re-encrypted on next save',
      );
      return payload;
    }

    const body = payload.slice(VERSION_PREFIX.length);
    const parts = body.split(':');

    if (parts.length !== 3) {
      throw new Error('Malformed encrypted token payload');
    }

    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Malformed encrypted token payload');
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }
}
