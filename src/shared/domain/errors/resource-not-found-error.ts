import { UseCaseError } from '@/shared/domain/errors/use-case-error';

export class ResourceNotFoundError extends Error implements UseCaseError {
  constructor() {
    super('Resource not found');
  }
}
