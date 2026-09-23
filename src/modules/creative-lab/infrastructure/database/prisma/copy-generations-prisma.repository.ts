import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from 'generated/prisma/client';
import {
  CopyGenerationsRepositoryInterface,
  type CopySubject,
  type PersistGenerationInput,
  type StoredGeneration,
  type StoredVariant,
} from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** O que toda leitura de geração traz — uma forma só, para não divergirem. */
const GENERATION_SELECT = {
  id: true,
  adId: true,
  source: true,
  status: true,
  context: true,
  inputDigest: true,
  engineVersion: true,
  promptVersion: true,
  aiProvider: true,
  aiModel: true,
  failureReason: true,
  createdAt: true,
  variants: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CopyGenerationSelect;

@Injectable()
export class CopyGenerationsPrismaRepository extends CopyGenerationsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * O anúncio com o que **situa a oferta**: campanha e conjunto.
   *
   * `subjectFor` da análise não serve aqui e não é redundância: ele não lê
   * objetivo de campanha nem meta de otimização, e não deveria — a análise roda
   * no ciclo noturno para toda a conta, e dois joins a mais por anúncio pesam
   * ali. Esta leitura roda por clique.
   */
  async subjectFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<CopySubject | null> {
    const ad = await this.prisma.ad.findFirst({
      where: { id: input.adId, organizationId: input.organizationId },
      select: {
        id: true,
        name: true,
        platform: true,
        accountId: true,
        creativeId: true,
        currentScoreId: true,
        campaign: { select: { objective: true } },
        adSet: { select: { optimizationGoal: true } },
        creative: {
          select: {
            title: true,
            body: true,
            callToAction: true,
            landingPageUrl: true,
            format: true,
          },
        },
      },
    });

    if (!ad) return null;

    return {
      adId: ad.id,
      adName: ad.name,
      platform: ad.platform,
      accountId: ad.accountId,
      creativeId: ad.creativeId,
      creativeFormat: ad.creative?.format ?? null,
      /**
       * Anúncio sem criativo sincronizado ainda gera: o texto atual vem vazio e
       * as regras factuais de sugestão já dizem o que falta. Recusar aqui
       * bloquearia justamente o anúncio que mais precisa de copy.
       */
      copy: {
        headline: ad.creative?.title ?? null,
        body: ad.creative?.body ?? null,
        callToAction: ad.creative?.callToAction ?? null,
      },
      landingPageUrl: ad.creative?.landingPageUrl ?? null,
      campaignObjective: ad.campaign?.objective ?? null,
      optimizationGoal: ad.adSet?.optimizationGoal ?? null,
      currentScoreId: ad.currentScoreId,
    };
  }

  async findByDigest(input: {
    organizationId: string;
    adId: string;
    inputDigest: string;
  }): Promise<StoredGeneration | null> {
    const row = await this.prisma.copyGeneration.findFirst({
      where: {
        organizationId: input.organizationId,
        adId: input.adId,
        inputDigest: input.inputDigest,
        // Reaproveitar uma geração que falhou devolveria a falha para sempre:
        // quem tenta de novo depois de o provider voltar receberia a lista
        // vazia da tentativa anterior.
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      select: GENERATION_SELECT,
    });

    return row ? toStored(row) : null;
  }

  async persist(input: PersistGenerationInput): Promise<StoredGeneration> {
    const created = await this.prisma.copyGeneration.create({
      data: {
        organizationId: input.organizationId,
        accountId: input.accountId,
        adId: input.adId,
        creativeId: input.creativeId,
        analysisId: input.analysisId,
        adScoreId: input.adScoreId,
        source: input.source,
        status: input.status,
        context: input.context as unknown as Prisma.InputJsonValue,
        inputDigest: input.inputDigest,
        engineVersion: input.engineVersion,
        promptVersion: input.promptVersion,
        aiProvider: input.aiProvider,
        aiModel: input.aiModel,
        failureReason: input.failureReason,
        retentionUntil: input.retentionUntil,
        variants: {
          create: input.variants.map((variant) => ({
            // Denormalizado na variante para que a política de RLS incida sobre
            // ela sem join. É a mesma razão de `organization_id` em toda tabela
            // de inteligência (G2).
            organizationId: input.organizationId,
            angle: variant.angle,
            hook: variant.hook,
            primaryText: variant.primaryText,
            headline: variant.headline,
            description: variant.description,
            callToAction: variant.callToAction,
            reasoning: variant.reasoning as Prisma.InputJsonValue,
          })),
        },
      },
      select: GENERATION_SELECT,
    });

    return toStored(created);
  }

  async findById(input: {
    organizationId: string;
    generationId: string;
  }): Promise<StoredGeneration | null> {
    const row = await this.prisma.copyGeneration.findFirst({
      where: { id: input.generationId, organizationId: input.organizationId },
      select: GENERATION_SELECT,
    });

    return row ? toStored(row) : null;
  }

  async listForAd(input: {
    organizationId: string;
    adId: string;
    limit: number;
  }): Promise<StoredGeneration[]> {
    const rows = await this.prisma.copyGeneration.findMany({
      where: { organizationId: input.organizationId, adId: input.adId },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      select: GENERATION_SELECT,
    });

    return rows.map(toStored);
  }

  /**
   * Escolher uma desmarca as irmãs, **na mesma transação**.
   *
   * Duas escritas soltas deixariam a geração com duas escolhidas se a segunda
   * falhasse — e "a escolhida" é o que `recommendations` lê para saber se
   * `REPLACE_COPY` tem parâmetro. Duas respostas para essa pergunta é uma ação
   * em mídia paga com texto ambíguo.
   */
  async select(input: {
    organizationId: string;
    variantId: string;
  }): Promise<StoredVariant | null> {
    const variant = await this.prisma.copyVariant.findFirst({
      where: { id: input.variantId, organizationId: input.organizationId },
      select: { id: true, generationId: true },
    });

    if (!variant) return null;

    const [, updated] = await this.prisma.$transaction([
      this.prisma.copyVariant.updateMany({
        where: { generationId: variant.generationId, selected: true },
        data: { selected: false, selectedAt: null },
      }),
      this.prisma.copyVariant.update({
        where: { id: variant.id },
        data: { selected: true, selectedAt: new Date() },
      }),
    ]);

    return toVariant(updated);
  }

  /**
   * Casa a execução com a variação **pelo dígito do texto**.
   *
   * O dígito é calculado aqui sobre o que está gravado, com a mesma função que
   * `platform-actions` usa para conferir a confirmação de R14 — `sha256` do
   * texto `trim()`ado. Dois hashes do mesmo texto divergem no primeiro ajuste de
   * normalização, e o que erra é o que ninguém exercita.
   *
   * A busca é limitada às variações **deste anúncio**: o mesmo texto pode ter
   * sido gerado para outro, e carimbar a variação errada é pior que não
   * carimbar nenhuma.
   */
  async linkApplied(input: {
    organizationId: string;
    adId: string;
    contentDigest: string;
    executionId: string;
    appliedAt: Date;
  }): Promise<void> {
    const candidates = await this.prisma.copyVariant.findMany({
      where: {
        organizationId: input.organizationId,
        generation: { adId: input.adId },
        appliedActionExecutionId: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        primaryText: true,
        headline: true,
        description: true,
        callToAction: true,
      },
    });

    // Título e descrição entram porque o Google os aplica: um asset trocado a
    // partir da variação precisa casar com ela como o texto principal casa.
    const match = candidates.find((variant) =>
      [
        variant.primaryText,
        variant.headline,
        variant.description,
        variant.callToAction,
      ].some((text) => digestOf(text) === input.contentDigest),
    );

    if (!match) return;

    await this.prisma.copyVariant.update({
      where: { id: match.id },
      data: {
        appliedActionExecutionId: input.executionId,
        appliedAt: input.appliedAt,
      },
    });
  }
}

/**
 * O mesmo dígito que `platform-actions` calcula para a confirmação de R14 —
 * `sha256` do texto `trim()`ado.
 *
 * Reproduzido aqui em vez de importado porque `creative-lab` não deve depender
 * do módulo de escrita: a definição cabe em uma linha, e a igualdade entre as
 * duas é o que o teste do vínculo exercita.
 */
function digestOf(text: string | null): string | null {
  if (!text) return null;

  return createHash('sha256').update(text.trim()).digest('hex');
}

type VariantRow = {
  id: string;
  angle: string;
  hook: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  callToAction: string | null;
  reasoning: unknown;
  selected: boolean;
  selectedAt: Date | null;
  appliedActionExecutionId: string | null;
  appliedAt: Date | null;
};

function toVariant(row: VariantRow): StoredVariant {
  return {
    id: row.id,
    angle: row.angle as StoredVariant['angle'],
    hook: row.hook,
    primaryText: row.primaryText,
    headline: row.headline,
    description: row.description,
    callToAction: row.callToAction,
    reasoning: row.reasoning,
    selected: row.selected,
    selectedAt: row.selectedAt,
    appliedActionExecutionId: row.appliedActionExecutionId,
    appliedAt: row.appliedAt,
  };
}

function toStored(row: {
  id: string;
  adId: string;
  source: string;
  status: string;
  context: unknown;
  inputDigest: string;
  engineVersion: string;
  promptVersion: string;
  aiProvider: string | null;
  aiModel: string | null;
  failureReason: string | null;
  createdAt: Date;
  variants: VariantRow[];
}): StoredGeneration {
  return {
    id: row.id,
    adId: row.adId,
    source: row.source,
    status: row.status,
    context: row.context,
    inputDigest: row.inputDigest,
    engineVersion: row.engineVersion,
    promptVersion: row.promptVersion,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    variants: row.variants.map(toVariant),
  };
}
