import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { SecurityAuditLogService } from 'src/modules/security/application';
import { WriteConsentRepositoryInterface } from 'src/modules/platform-actions/domain/ports/write-consent.repository';
import { ActionWriteSettingsReader } from 'src/modules/platform-actions/domain/ports/action-write-settings.reader';
import { GrantWriteConsentDto } from 'src/modules/platform-actions/application/dtos/write-consent.dto';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * Consentimento e kill switch — **os dois controles distintos de §13.5.**
 *
 * O consentimento diz *"você pode escrever nesta integração, nestes tipos"* e é
 * uma decisão de relação, registrada com quem, quando e de onde. O kill switch
 * diz *"pare tudo agora"* e é uma alavanca de operação. Fundir os dois daria ao
 * usuário uma escolha entre revogar a autorização — que ele teria de reconceder
 * item a item depois — e não conseguir parar nada.
 *
 * Os dois gravam em **auditoria e trilha de segurança**: mudam quem pode mover
 * dinheiro, o que é evento de negócio e evento de segurança ao mesmo tempo.
 */
@Injectable()
export class GrantWriteConsentUseCase {
  constructor(
    private readonly consents: WriteConsentRepositoryInterface,
    private readonly audit: AuditLogService,
    private readonly security: SecurityAuditLogService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    integrationId: string;
    body: GrantWriteConsentDto;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    const consent = await this.consents.grant({
      organizationId: input.organizationId,
      integrationId: input.integrationId,
      grantedByAccountId: input.accountId,
      consentedActionTypes: input.body.consentedActionTypes,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await Promise.all([
      this.audit.record({
        event: 'integration.write_consent.granted',
        entityType: 'IntegrationWriteConsent',
        entityId: consent.id,
        actorId: input.accountId,
        organizationId: input.organizationId,
        metadata: {
          integrationId: input.integrationId,
          consentedActionTypes: consent.consentedActionTypes,
        },
      }),
      this.security.record({
        event: 'platform_write.consent_granted',
        severity: 'warning',
        accountId: input.accountId,
        organizationId: input.organizationId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: {
          integrationId: input.integrationId,
          consentedActionTypes: consent.consentedActionTypes,
        },
      }),
    ]);

    return envelope(consent, { asOf: new Date().toISOString() });
  }
}

@Injectable()
export class RevokeWriteConsentUseCase {
  constructor(
    private readonly consents: WriteConsentRepositoryInterface,
    private readonly audit: AuditLogService,
    private readonly security: SecurityAuditLogService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    integrationId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    const consent = await this.consents.revoke({
      organizationId: input.organizationId,
      integrationId: input.integrationId,
      revokedByAccountId: input.accountId,
    });

    if (!consent) {
      throw new NotFoundException(
        'Não há consentimento ativo para esta integração',
      );
    }

    await Promise.all([
      this.audit.record({
        event: 'integration.write_consent.revoked',
        entityType: 'IntegrationWriteConsent',
        entityId: consent.id,
        actorId: input.accountId,
        organizationId: input.organizationId,
        metadata: { integrationId: input.integrationId },
      }),
      this.security.record({
        event: 'platform_write.consent_revoked',
        severity: 'warning',
        accountId: input.accountId,
        organizationId: input.organizationId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: { integrationId: input.integrationId },
      }),
    ]);

    return envelope(consent, { asOf: new Date().toISOString() });
  }
}

@Injectable()
export class ListWriteConsentsUseCase {
  constructor(
    private readonly consents: WriteConsentRepositoryInterface,
    private readonly settings: ActionWriteSettingsReader,
    private readonly env: EnvService,
  ) {}

  /**
   * Os consentimentos **e os três portões de escrita**.
   *
   * Os portões vêm junto porque a tela que gerencia consentimento é a mesma que
   * precisa dizer se a escrita sai — e até aqui `organizationActionsEnabled` só
   * era legível por `GET /ads/{id}/actions/available`, que exige um anúncio.
   * Uma tela de configuração de segurança não pode depender de haver um anúncio
   * para saber se está ligada.
   *
   * **Os três são separados de propósito**, como em §13.3: consentir numa
   * integração não adianta se a instalação não escreve, e nenhum dos dois
   * adianta se o kill switch da organização está acionado — e só o último tem
   * ação do lado do usuário.
   */
  async execute(input: { organizationId: string }) {
    const [consents, actionsEnabled] = await Promise.all([
      this.consents.listFor({ organizationId: input.organizationId }),
      this.settings.actionsEnabled(input.organizationId),
    ]);

    return envelope(
      {
        consents,
        writeGates: {
          installationEnabled: this.env.get('PLATFORM_ACTIONS_ENABLED'),
          dryRunOnly: this.env.get('PLATFORM_ACTIONS_DRY_RUN_ONLY'),
          organizationActionsEnabled: actionsEnabled,
        },
      },
      { asOf: new Date().toISOString() },
    );
  }
}

/**
 * O kill switch (§13.5) — **desliga em menos de uma requisição.**
 *
 * A garantia vem de onde a leitura acontece: `Organization.actionsEnabled` é
 * lida do banco a cada pedido de escrita, sem cache. Um cache de trinta
 * segundos aqui seria a diferença entre parar e "parar daqui a pouco", numa
 * alavanca cujo único propósito é ser usada quando algo já está errado.
 */
@Injectable()
export class ToggleActionsKillSwitchUseCase {
  constructor(
    private readonly settings: ActionWriteSettingsReader,
    private readonly audit: AuditLogService,
    private readonly security: SecurityAuditLogService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    enabled: boolean;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    await this.settings.setActionsEnabled({
      organizationId: input.organizationId,
      enabled: input.enabled,
    });

    await Promise.all([
      this.audit.record({
        event: 'organization.actions_toggled',
        entityType: 'Organization',
        entityId: input.organizationId,
        actorId: input.accountId,
        organizationId: input.organizationId,
        metadata: { enabled: input.enabled },
      }),
      this.security.record({
        event: 'platform_write.kill_switch_toggled',
        // Religar é o movimento perigoso: desligar só reduz o que pode
        // acontecer. Por isso a severidade acompanha a direção.
        severity: input.enabled ? 'critical' : 'warning',
        accountId: input.accountId,
        organizationId: input.organizationId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: { enabled: input.enabled },
      }),
    ]);

    return envelope(
      { organizationId: input.organizationId, actionsEnabled: input.enabled },
      { asOf: new Date().toISOString() },
    );
  }
}
