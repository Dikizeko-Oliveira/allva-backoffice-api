import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import type { OperatorRequest } from '../operator-request';

export const CurrentOperator = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<OperatorRequest>();
    return request.operator as Operator;
  },
);
