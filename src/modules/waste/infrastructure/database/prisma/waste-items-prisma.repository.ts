import { Injectable } from '@nestjs/common';
import {
  WasteItemsRepositoryInterface,
  type AdWasteDenormalization,
  type OpenWasteItem,
  type WasteItemWrite,
  type WasteResolutionWrite,
  type WasteUpsertResult,
} from 'src/modules/waste/domain/ports/waste-items.repository';
import type {
  FindingType,
  WasteResolutionKind,
} from 'src/modules/waste/domain/contracts/finding-catalog';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  fromPrismaJsonObject,
  toPrismaJson,
} from 'src/shared/infrastructure/database/prisma/json';

/** Meia-noite UTC — a fronteira da janela diária de `occurrences`. */
function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

@Injectable()
export class WasteItemsPrismaRepository extends WasteItemsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async openItemsFor(input: {
    organizationId: string;
    adIds: string[];
  }): Promise<OpenWasteItem[]> {
    if (input.adIds.length === 0) return [];

    const rows = await this.prisma.wasteItem.findMany({
      where: {
        organizationId: input.organizationId,
        adId: { in: input.adIds },
        // `resolved_at IS NULL` é a definição de aberto — a mesma da view
        // `open_waste` e a mesma do índice parcial. Filtrar por `status` aqui
        // seria a segunda fonte de verdade que D10 existe para eliminar.
        resolvedAt: null,
      },
      select: {
        id: true,
        adId: true,
        type: true,
        fingerprint: true,
        detectorVersion: true,
        occurrences: true,
        lastSeenAt: true,
        windowDays: true,
        evidence: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      adId: row.adId,
      type: row.type as FindingType,
      fingerprint: row.fingerprint,
      detectorVersion: row.detectorVersion,
      occurrences: row.occurrences,
      lastSeenAt: row.lastSeenAt,
      windowDays: row.windowDays,
      observed: observedFrom(row.evidence),
    }));
  }

  /**
   * Upsert por fingerprint (§10.7 passo 6).
   *
   * `occurrences` incrementa **somente** quando `lastSeenAt` é de janela
   * anterior — a comparação é contra a meia-noite UTC do dia corrente. Sem essa
   * condição, um retry de fila ou o cron sobrepondo a cadeia por evento inflaria
   * o contador no mesmo dia, e `occurrences` é sinal que P8 usa para medir
   * persistência do problema, não frequência de execução do worker.
   */
  async upsertMany(
    writes: WasteItemWrite[],
    now: Date,
  ): Promise<WasteUpsertResult[]> {
    if (writes.length === 0) return [];

    const dayStart = utcDay(now);
    const existing = await this.prisma.wasteItem.findMany({
      where: {
        fingerprint: { in: writes.map((write) => write.fingerprint) },
        resolvedAt: null,
      },
      select: { id: true, fingerprint: true, lastSeenAt: true },
    });

    const byFingerprint = new Map(
      existing.map((row) => [row.fingerprint, row]),
    );

    const results: WasteUpsertResult[] = [];

    for (const write of writes) {
      const current = byFingerprint.get(write.fingerprint);

      const payload = {
        priority: write.priority,
        windowDays: write.windowDays,
        incurredAmount: write.incurredAmount,
        incurredAmountBase: write.incurredAmountBase,
        avoidableDailyAmount: write.avoidableDailyAmount,
        avoidableDailyBase: write.avoidableDailyBase,
        currency: write.currency,
        baseCurrency: write.baseCurrency,
        diagnosis: write.diagnosis,
        evidence: toPrismaJson(write.evidence as never),
        evidenceSufficiency: write.evidenceSufficiency,
        scopeLevel: write.scopeLevel,
        dataMaturity: write.dataMaturity ?? 'IMMATURE',
        detectorVersion: write.detectorVersion,
        detectorProfileVersion: write.detectorProfileVersion,
        creativeId: write.creativeId,
        lastSeenAt: now,
        staleObservation: false,
      };

      if (current) {
        await this.prisma.wasteItem.update({
          where: { id: current.id },
          data: {
            ...payload,
            ...(current.lastSeenAt < dayStart
              ? { occurrences: { increment: 1 } }
              : {}),
          },
        });

        results.push({
          fingerprint: write.fingerprint,
          id: current.id,
          created: false,
        });
        continue;
      }

      const created = await this.prisma.wasteItem.create({
        data: {
          ...payload,
          adId: write.adId,
          organizationId: write.organizationId,
          accountId: write.accountId,
          findingKind: write.findingKind,
          type: write.type,
          fingerprint: write.fingerprint,
          detectedAt: now,
          status: 'OPEN',
        },
        select: { id: true },
      });

      results.push({
        fingerprint: write.fingerprint,
        id: created.id,
        created: true,
      });
    }

    return results;
  }

  /**
   * `status` e `resolved_at` são escritos **juntos**, sempre.
   *
   * O `CHECK ((status='OPEN') = (resolved_at IS NULL))` recusaria a linha
   * incoerente, mas depender do banco para lembrar é como o v1 acumulou itens
   * `RESOLVED` com `resolved_at` nulo — contados como abertos pela view e como
   * resolvidos pela lista, em silêncio (D10, achado A7).
   */
  async resolveMany(resolutions: WasteResolutionWrite[]): Promise<number> {
    let affected = 0;

    for (const resolution of resolutions) {
      const result = await this.prisma.wasteItem.updateMany({
        where: { id: resolution.id, resolvedAt: null },
        data: {
          status: 'RESOLVED',
          resolvedAt: resolution.resolvedAt,
          resolutionKind: resolution.kind,
          resolvedByAccountId: resolution.resolvedByAccountId ?? null,
          resolvedByActionExecutionId:
            resolution.resolvedByActionExecutionId ?? null,
          staleObservation: false,
        },
      });

      affected += result.count;
    }

    return affected;
  }

  async markStaleObservation(input: {
    ids: string[];
    stale: boolean;
  }): Promise<number> {
    if (input.ids.length === 0) return 0;

    const result = await this.prisma.wasteItem.updateMany({
      where: { id: { in: input.ids }, resolvedAt: null },
      data: { staleObservation: input.stale },
    });

    return result.count;
  }

  /**
   * A denormalização de leitura em `ads` (§5.4, grupo do `waste`).
   *
   * Escrita em lote por `UPDATE ... FROM (VALUES ...)`: em A2-S3 o `update`
   * linha a linha custou 31 s para 500 anúncios, e o ciclo diário percorre a
   * conta inteira — inclusive os anúncios **sem** achado, que precisam ter a
   * coluna zerada, senão um anúncio que deixou de ter desperdício continuaria
   * exibindo o número da última vez que teve.
   */
  async denormalizeIntoAds(updates: AdWasteDenormalization[]): Promise<void> {
    if (updates.length === 0) return;

    const values: unknown[] = [];
    const tuples: string[] = [];

    updates.forEach((update, index) => {
      const start = index * 9;
      values.push(
        update.adId,
        update.openWasteCount,
        update.openWasteAmount,
        update.openWasteAmountBase,
        update.openWasteCurrency,
        update.avoidableDailyAmountBase,
        update.wasteAsOf,
        update.evidenceGaps ? JSON.stringify(update.evidenceGaps) : null,
        update.evidenceGaps !== undefined,
      );
      tuples.push(
        `($${start + 1}, $${start + 2}::int, $${start + 3}::numeric, ` +
          `$${start + 4}::numeric, $${start + 5}::text, $${start + 6}::numeric, ` +
          `$${start + 7}::timestamptz, $${start + 8}::jsonb, $${start + 9}::boolean)`,
      );
    });

    // As lacunas de evidência viajam na mesma escrita: são o outro lado do
    // mesmo ciclo — o que ele encontrou e o que ele não pôde julgar — e
    // gravá-las separado deixaria a tela, por um instante, com uma metade de
    // hoje e a outra de ontem.
    const sql =
      'UPDATE "ads" AS a SET ' +
      '"open_waste_count" = v.count, ' +
      '"open_waste_amount" = v.amount, ' +
      '"open_waste_amount_base" = v.amount_base, ' +
      '"open_waste_currency" = v.currency, ' +
      '"avoidable_daily_amount_base" = v.avoidable_daily, ' +
      '"waste_as_of" = v.as_of, ' +
      '"evidence_gaps" = CASE WHEN v.gaps_written THEN v.evidence_gaps ELSE a."evidence_gaps" END, ' +
      '"evidence_gaps_as_of" = CASE WHEN v.gaps_written THEN v.as_of ELSE a."evidence_gaps_as_of" END ' +
      `FROM (VALUES ${tuples.join(', ')}) AS v(id, count, amount, amount_base, currency, avoidable_daily, as_of, evidence_gaps, gaps_written) ` +
      'WHERE a."id" = v.id';

    await this.prisma.$executeRawUnsafe(sql, ...values);
  }

  async resolveOne(input: {
    id: string;
    organizationId: string;
    kind: Extract<WasteResolutionKind, 'RESOLVED_EXTERNALLY' | 'DISMISSED'>;
    reason: string;
    resolvedByAccountId: string;
    now: Date;
  }): Promise<{ id: string; adId: string; kind: WasteResolutionKind } | null> {
    const item = await this.prisma.wasteItem.findFirst({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        resolvedAt: null,
      },
      select: { id: true, adId: true, evidence: true },
    });

    if (!item) return null;

    const updated = await this.prisma.wasteItem.updateMany({
      where: { id: item.id, resolvedAt: null },
      data: {
        status: 'RESOLVED',
        resolvedAt: input.now,
        resolutionKind: input.kind,
        resolvedByAccountId: input.resolvedByAccountId,
        staleObservation: false,
        // O motivo entra na evidência, ao lado dos limiares que dispararam o
        // achado: é ali que "por que este item existe?" já é respondido, e a
        // resposta a "por que ele deixou de existir?" pertence ao mesmo lugar.
        evidence: toPrismaJson({
          ...fromPrismaJsonObject(item.evidence),
          manualResolution: {
            kind: input.kind,
            reason: input.reason,
            at: input.now.toISOString(),
          },
        }),
      },
    });

    // Zero linhas: outra requisição resolveu entre a leitura e a escrita.
    // Devolver o item mesmo assim faria duas resoluções emitirem dois eventos.
    if (updated.count === 0) return null;

    return { id: item.id, adId: item.adId, kind: input.kind };
  }

  /**
   * Resolução em lote pelos abertos de um anúncio (§10.9).
   *
   * Item a item, e não um `updateMany` só, porque cada linha recebe o motivo
   * **dentro da própria evidência** — e a evidência de cada achado é diferente.
   * Um `updateMany` sobrescreveria as três com o mesmo objeto, apagando os
   * limiares que dispararam cada um: exatamente a informação que P7 existe para
   * preservar.
   */
  async resolveForAd(input: {
    adId: string;
    organizationId: string;
    types?: FindingType[];
    kind: Extract<WasteResolutionKind, 'RESOLVED_EXTERNALLY' | 'DISMISSED'>;
    reason: string;
    resolvedByAccountId: string;
    now: Date;
  }): Promise<Array<{ id: string; type: FindingType }>> {
    const open = await this.prisma.wasteItem.findMany({
      where: {
        adId: input.adId,
        organizationId: input.organizationId,
        resolvedAt: null,
        ...(input.types?.length ? { type: { in: input.types } } : {}),
      },
      select: { id: true, type: true },
    });

    const resolved: Array<{ id: string; type: FindingType }> = [];

    for (const item of open) {
      const result = await this.resolveOne({
        id: item.id,
        organizationId: input.organizationId,
        kind: input.kind,
        reason: input.reason,
        resolvedByAccountId: input.resolvedByAccountId,
        now: input.now,
      });

      // `null` = outra requisição fechou entre a leitura e a escrita. Ele fica
      // fora da lista, e é o que impede dois eventos para a mesma resolução.
      if (result)
        resolved.push({ id: item.id, type: item.type as FindingType });
    }

    return resolved;
  }

  /**
   * Recalcula as colunas de `ads` a partir da view — o `MAX` de §10.6 em SQL.
   *
   * `LEFT JOIN` com `COALESCE`: um anúncio que ficou **sem** achado aberto
   * precisa ser zerado, e ele não aparece na subconsulta. Sem o `LEFT`, o
   * anúncio recém-resolvido manteria o número da última detecção — que é o caso
   * que esta função existe para cobrir.
   */
  async recomputeDenormalization(adIds: string[], now: Date): Promise<void> {
    if (adIds.length === 0) return;

    const placeholders = adIds.map((_, index) => `$${index + 2}`).join(', ');

    await this.prisma.$executeRawUnsafe(
      `UPDATE "ads" AS a SET
              "open_waste_count" = COALESCE(w.items, 0),
              "open_waste_amount" = COALESCE(w.amount, 0),
              "open_waste_amount_base" = COALESCE(w.amount_base, 0),
              "open_waste_currency" = w.currency,
              "avoidable_daily_amount_base" = COALESCE(w.avoidable_base, 0),
              "waste_as_of" = $1::timestamptz
         FROM (SELECT a2."id" AS ad_id, w2.items, w2.amount, w2.amount_base,
                      w2.avoidable_base, w2.currency
                 FROM "ads" a2
                 LEFT JOIN (
                   SELECT "ad_id",
                          COUNT(*) AS items,
                          MAX("incurred_amount") AS amount,
                          MAX("incurred_amount_base") AS amount_base,
                          MAX("avoidable_daily_base") AS avoidable_base,
                          MIN("currency") AS currency
                     FROM "open_waste"
                    GROUP BY "ad_id"
                 ) w2 ON w2."ad_id" = a2."id"
                WHERE a2."id" IN (${placeholders})
              ) w
        WHERE a."id" = w.ad_id`,
      now,
      ...adIds,
    );
  }
}

/** `evidence.observed` de quando o item foi gravado, ou `null`. */
function observedFrom(evidence: unknown): Record<string, number> | null {
  const parsed = fromPrismaJsonObject(evidence as never);
  const observed = parsed.observed;

  if (typeof observed !== 'object' || observed === null) return null;

  const numbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(observed)) {
    if (typeof value === 'number') numbers[key] = value;
  }

  return numbers;
}
