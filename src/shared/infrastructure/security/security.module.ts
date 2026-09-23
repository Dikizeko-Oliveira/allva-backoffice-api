import { Global, Module } from '@nestjs/common';
import { TokenCipherService } from './token-cipher.service';

@Global()
@Module({
  providers: [TokenCipherService],
  exports: [TokenCipherService],
})
export class SecurityModule {}
