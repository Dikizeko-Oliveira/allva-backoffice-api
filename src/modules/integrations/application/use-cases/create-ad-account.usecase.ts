import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { CreateAdAccountInputDto, CreateAdAccountOutputDto } from '../dtos';
import { AdAccount } from 'src/modules/integrations/domain/entities';
import { slugToPlatform } from 'src/modules/integrations/domain/entities/platform';
import {
  AdAccountsRepositoryInterface,
  IntegrationsRepositoryInterface,
} from 'src/modules/integrations/domain/ports';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';

@Injectable()
export class CreateAdAccountUseCase {
  constructor(
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  async execute(
    input: CreateAdAccountInputDto,
    accountId: string,
  ): Promise<CreateAdAccountOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    /**
     * `provider` chega como string livre do DTO, e a coluna é enum.
     *
     * Sem normalizar, `"meta"` minúsculo atravessava a camada de aplicação e só
     * estourava no Prisma — o usuário recebia 500 por um valor que a rota
     * aceitou. Normalizar aqui transforma isso num 400 que diz o que está
     * errado.
     */
    const platform = slugToPlatform(input.provider);

    if (!platform) {
      throw new BadRequestException({
        code: 'PLATFORM_NOT_AVAILABLE',
        message: `Platform "${input.provider}" is not supported`,
      });
    }

    const integration = await this.integrationsRepository.findById(
      input.integrationId,
    );

    /**
     * A credencial precisa ser **do escopo de quem pede** (A-6).
     *
     * Sem esta guarda, `findById` por id puro aceitava o `integrationId` de
     * outro tenant e a conta nascia com o `organizationId` copiado dele: escrita
     * cross-tenant, consumindo a cota do plano alheio e passando a sincronizar
     * com a credencial alheia. É a mesma resolução de escopo que as rotas
     * canônicas já usam.
     *
     * Integração alheia responde `INTEGRATION_NOT_FOUND`, e não `FORBIDDEN`:
     * distinguir as duas confirmaria a existência do id para quem está
     * sondando.
     */
    const owner = await this.ownerScope.resolveForAccount(accountId);

    if (
      !integration ||
      !this.ownerScope.isIntegrationOwned(owner, integration)
    ) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_FOUND',
        message: 'Integration not found',
      });
    }

    const adAccount = AdAccount.create({
      integrationId: integration.id,
      organizationId: integration.organizationId,
      accountId,
      platform,
      externalAccountId: input.externalAccountId ?? input.accountId ?? '',
      name: input.name,
      currency: input.currency,
      timezone: input.timezone,
    });

    await this.adAccountsRepository.save(adAccount);

    return { id: adAccount.id };
  }
}
