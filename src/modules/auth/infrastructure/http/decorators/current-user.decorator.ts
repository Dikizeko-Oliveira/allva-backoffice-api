import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Account } from 'src/modules/accounts/domain/entities';

export const CurrentUser = createParamDecorator((_, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user as Account;
});
