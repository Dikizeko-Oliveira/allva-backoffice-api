import { BadRequestException, Injectable } from '@nestjs/common';
import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import {
  OrganizationInvitationsRepositoryInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { PreviewOrganizationInvitationOutputDto } from '../dtos';

/**
 * A pré-visualização pública de um convite (`GET /invitations/preview`).
 *
 * Quem abre o link do e-mail ainda não tem sessão - é exatamente por isso que a
 * tela de aceite manda essa pessoa para login/cadastro antes de poder aceitar.
 * Sem este endpoint, aquele formulário nascia com o campo de e-mail em branco:
 * quem convidou já sabe o endereço, mas quem aceita tinha que redigitá-lo, e um
 * erro de digitação só aparecia depois do cadastro inteiro, quando o aceite
 * comparasse o e-mail da conta nova com o do convite e recusasse
 * (`INVITATION_INVALID`, o mesmo código genérico de sempre).
 *
 * **Mesma recusa genérica do aceite, pelo mesmo motivo.** O token já é a prova
 * de posse - 256 bits, nunca persistido em claro -, então devolver o e-mail
 * para quem o possui não vaza nada que o e-mail original não tivesse
 * entregado. O que a resposta não pode fazer é **diferenciar** motivos de
 * falha (expirado vs. revogado vs. já aceito vs. nunca existiu): dar pistas
 * diferentes por caminho transformaria esta rota pública, sem exigir
 * autenticação, num oráculo para testar tokens antigos.
 */
@Injectable()
export class PreviewOrganizationInvitationUseCase {
  private invalidInvitation(): BadRequestException {
    return new BadRequestException({
      code: 'INVITATION_INVALID',
      message: 'Invitation is invalid, expired or has already been used',
    });
  }

  constructor(
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
  ) {}

  async execute(
    token: string,
  ): Promise<PreviewOrganizationInvitationOutputDto> {
    if (!token) throw this.invalidInvitation();

    const tokenHash = OrganizationInvitation.hashToken(token);
    const invitation =
      await this.invitationsRepository.findByTokenHash(tokenHash);

    if (!invitation || !invitation.isPending()) {
      throw this.invalidInvitation();
    }

    const organization = await this.organizationsRepository.findById(
      invitation.organizationId,
    );

    return {
      email: invitation.email,
      organizationName: organization?.name ?? '',
    };
  }
}
