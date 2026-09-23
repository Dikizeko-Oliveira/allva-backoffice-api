import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PasswordHasherInterface } from 'src/modules/auth/domain/ports';

@Injectable()
export class ArgonPasswordHasher implements PasswordHasherInterface {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }
}
