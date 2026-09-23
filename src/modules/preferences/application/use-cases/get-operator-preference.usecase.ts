import { Injectable } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import { OperatorPreference } from 'src/modules/preferences/domain/entities';
import { OperatorPreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { OperatorPreferenceOutputDto } from '../dtos';
import { toOperatorPreferenceOutput } from '../preferences.presenter';

/**
 * As preferências do **próprio** operador. Sem permissão de plataforma: todo
 * operador tem as suas, e ninguém lê as de outro — o id vem do token, nunca da
 * URL.
 */
@Injectable()
export class GetOperatorPreferenceUseCase {
  constructor(
    private readonly preferencesRepository: OperatorPreferencesRepositoryInterface,
  ) {}

  async execute(operator: Operator): Promise<OperatorPreferenceOutputDto> {
    const preference =
      (await this.preferencesRepository.findByOperatorId(operator.id)) ??
      OperatorPreference.defaultsFor(operator.id);

    return toOperatorPreferenceOutput(preference);
  }
}
