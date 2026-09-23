import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { OperatorRequest } from './operator-context';

export const CurrentOperator = createParamDecorator(
  (_: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    return request.operator;
  },
);
