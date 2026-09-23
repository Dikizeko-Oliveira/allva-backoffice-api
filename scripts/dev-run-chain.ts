/**
 * Roda a cadeia de inteligência **agora**, na ordem de §8.8, sem esperar a
 * madrugada.
 *
 * ```text
 * analysis-scope → ad-scoring → waste-detection → denormalization-reconcile
 *                → recommendations-generation
 * ```
 *
 * `analysis-scope` (05:00) abre a fila e **não é detalhe**: ele é quem carimba
 * `ads.analysisEligibleAt`, e `listScorable`/`listDetectable` filtram por esse
 * carimbo. Sem ele os dois motores enxergam zero anúncios e a cadeia inteira
 * conclui com sucesso sem ter feito nada — foi exatamente assim que a primeira
 * versão deste script se comportou. Ele é global por natureza (a régua é por
 * plano, sobre todas as organizações), então `--org`/`--owner` não o restringem.
 *
 * ## Por que chama os serviços direto, e não os dispatchers
 *
 * O caminho de produção passa pelos workers, e cada worker pergunta ao
 * `JobCoordinatorService` se o job de cima terminou **na mesma janela** antes de
 * fazer qualquer trabalho: `ad-scoring` depende de `ads-ingest-full`,
 * `waste-detection` depende de `ad-scoring`. É a garantia que impede pontuar
 * série incompleta — e é exatamente o que torna o caminho de produção inútil
 * para testar.
 *
 * Sobre dado de `seed:ads-v2` **nenhum ingest jamais rodou**, então
 * `upstreamReady` responde não e a cadeia inteira sai como `UPSTREAM_NOT_READY`
 * sem processar nada. Enfileirar aqui produziria três `SKIPPED` e uma tela
 * vazia, indistinguível de bug.
 *
 * Chamar o serviço pula o lease e a dependência de propósito: este script
 * afirma "rode sobre o que existe no banco, agora". É ferramenta de
 * desenvolvimento, e a diferença para produção está declarada aqui para não
 * virar surpresa quando os números não baterem com os de um ciclo real.
 *
 * ## O gate de integração viva — e por que `seed:ads-v2` agora o satisfaz
 *
 * Desde `ab0e902` ("Varredura de acesso fechado nos jobs de sync e scoring"),
 * `listAccountsToScore`/`listAccountsToDetect`/`analysis-scope` só enxergam
 * conta cuja `AdAccount.integrationId` aponte para uma `Integration` com
 * status sincronizável (`SWEEPABLE_AD_ACCOUNT_SQL`). Até a entrega anterior
 * `seed:ads-v2` nunca criava `Integration`, então este script rodava sobre
 * zero contas sempre, com dado de seed — o exato "sucesso que não fez nada"
 * que ele existe para evitar. `seed:ads-v2` passou a criar, por pedido
 * explícito, uma `Integration` **obviamente fake** por plataforma (nome
 * começando em `seed-FAKE`, token que não abre nada) só para satisfazer esse
 * gate; ver o cabeçalho de `seed-ads-v2.ts` para o que isso muda de visível
 * (a integração aparece em qualquer listagem de integrações da organização).
 * Uma organização semeada antes dessa mudança precisa rodar `seed:ads-v2` de
 * novo (sem `--reset`, o `update` já religa) para ganhar o vínculo.
 *
 * Desde que `seed:ads-v2` passou a semear três contas por organização — uma
 * por plataforma (META, GOOGLE, TIKTOK) —, cada estágio abaixo processa três
 * contas em vez de uma. Nenhum dos serviços filtra por `platform` (é dado que
 * atravessa, nunca condição de escopo — confirmado nos quatro módulos), então
 * nada aqui precisou mudar para isso funcionar; o único ajuste é de leitura:
 * os logs por conta agora nomeiam `[PLATAFORMA · nome da conta]` em vez de só
 * o uuid, e cada estágio abre com a contagem por plataforma, senão "3 conta(s)"
 * não diz se são as três esperadas ou três vezes a mesma.
 *
 * Uso:
 *   pnpm dev:chain                              # tudo que for elegível
 *   pnpm dev:chain -- --owner=voce@exemplo.com  # só a sua organização
 *   pnpm dev:chain -- --org=<id>
 */
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { AnalysisScopeService } from 'src/modules/analysis-scope/application/analysis-scope.service';
import { AdScoringTargetsRepositoryInterface } from 'src/modules/ad-scoring/domain/ports/ad-scoring-targets.repository';
import { ScoreAdAccountService } from 'src/modules/ad-scoring/application/services/score-ad-account.service';
import { WasteTargetsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-targets.repository';
import { DetectWasteService } from 'src/modules/waste/application/services/detect-waste.service';
import { WasteReconciliationService } from 'src/modules/waste/application/services/waste-reconciliation.service';
import { RecommendationTargetsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendation-targets.repository';
import { GenerateRecommendationsService } from 'src/modules/recommendations/application/services/generate-recommendations.service';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const argv = process.argv.slice(2);
const argValue = (name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

/**
 * Os ids de organização que este disparo cobre — `null` significa "todas".
 *
 * `--owner=` existe porque o id é um UUID e o e-mail é o que a pessoa sabe de
 * cor. Um e-mail sem organização ativa **para o script**: seguir em frente
 * rodaria a cadeia sobre todas as organizações, que é o oposto do que quem
 * escreveu o filtro pediu.
 */
async function resolveScope(
  prisma: PrismaService,
): Promise<Set<string> | null> {
  const org = argValue('org');
  const owner = argValue('owner');

  if (org && owner) {
    throw new Error('Use `--org=<id>` ou `--owner=<email>`, não os dois.');
  }

  if (org) return new Set([org]);
  if (!owner) return null;

  const organizations = await prisma.organization.findMany({
    where: { deletedAt: null, owner: { email: owner } },
    select: { id: true, name: true },
  });

  if (organizations.length === 0) {
    throw new Error(`Nenhuma organização ativa cujo dono seja ${owner}.`);
  }

  console.log(
    `🎯 escopo: ${organizations.map((o) => `${o.name} (${o.id})`).join(', ')}`,
  );

  return new Set(organizations.map((o) => o.id));
}

/**
 * `[PLATAFORMA · nome]` para cada `adAccountId` no escopo — só para os logs
 * não virarem uma parede de uuids indistinguíveis agora que uma organização
 * tem três contas em vez de uma.
 */
async function buildAccountLabels(
  prisma: PrismaService,
  scope: Set<string> | null,
): Promise<Map<string, string>> {
  const accounts = await prisma.adAccount.findMany({
    where: scope ? { organizationId: { in: [...scope] } } : {},
    select: { id: true, platform: true, name: true },
  });

  return new Map(accounts.map((a) => [a.id, `${a.platform} · ${a.name}`]));
}

/** Quantas contas em `ids` são de cada plataforma — abre cada estágio. */
function countByPlatform(ids: string[], labels: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const platform = labels.get(id)?.split(' · ')[0] ?? 'desconhecida';
    counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([platform, count]) => `${platform}=${count}`)
    .join(', ');
}

async function main(): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  const scope = await resolveScope(prisma);
  const keep = (organizationId: string): boolean =>
    scope === null || scope.has(organizationId);
  const labels = await buildAccountLabels(prisma, scope);
  const label = (adAccountId: string): string =>
    labels.get(adAccountId) ?? adAccountId;

  const ctx = createRootJobContext();
  const now = new Date();

  const analysisScope = app.get(AnalysisScopeService);
  const scoringTargets = app.get(AdScoringTargetsRepositoryInterface);
  const scoring = app.get(ScoreAdAccountService);
  const wasteTargets = app.get(WasteTargetsRepositoryInterface);
  const detection = app.get(DetectWasteService);
  const reconciliation = app.get(WasteReconciliationService);
  const recTargets = app.get(RecommendationTargetsRepositoryInterface);
  const generation = app.get(GenerateRecommendationsService);

  // ── ⓪ régua da noite ─────────────────────────────────────────────────────
  console.log('\n⓪ analysis-scope (global — define quem é analisável hoje)');
  console.log('  ', JSON.stringify(await analysisScope.execute(now)));

  // ── ① pontuação ──────────────────────────────────────────────────────────
  const toScore = (await scoringTargets.listAccountsToScore()).filter((a) =>
    keep(a.organizationId),
  );
  console.log(
    `\n① ad-scoring — ${toScore.length} conta(s) (${countByPlatform(
      toScore.map((a) => a.adAccountId),
      labels,
    )})`,
  );
  for (const { adAccountId } of toScore) {
    const out = await scoring.execute({ adAccountId, ctx, now });
    console.log(`   [${label(adAccountId)}]`, JSON.stringify(out));
  }

  // ── ② detecção + ③ reconciliação da denormalização ───────────────────────
  //
  // A reconciliação não é opcional para quem vai olhar a tela: `hasOpenWaste` e
  // `avoidableDaily` da lista de Anúncios saem de colunas denormalizadas, e sem
  // ela a detecção grava o achado e a lista continua ordenando pelo valor
  // velho.
  const toDetect = (await wasteTargets.listAccountsToDetect()).filter((a) =>
    keep(a.organizationId),
  );
  console.log(
    `\n② waste-detection — ${toDetect.length} conta(s) (${countByPlatform(
      toDetect.map((a) => a.adAccountId),
      labels,
    )})`,
  );
  for (const { adAccountId } of toDetect) {
    const out = await detection.execute({ adAccountId, ctx, now });
    console.log(`   [${label(adAccountId)}]`, JSON.stringify(out));
  }

  console.log(`\n③ denormalization-reconcile — ${toDetect.length} conta(s)`);
  for (const { adAccountId } of toDetect) {
    const out = await reconciliation.execute({ adAccountId, ctx, now });
    console.log(`   [${label(adAccountId)}]`, JSON.stringify(out));
  }

  // ── ④ geração de recomendações ───────────────────────────────────────────
  const organizations = (await recTargets.listOrganizationsToGenerate()).filter(
    keep,
  );
  console.log(
    `\n④ recommendations-generation — ${organizations.length} org(s)`,
  );
  for (const organizationId of organizations) {
    const out = await generation.execute({ organizationId, ctx, now });
    console.log(`   ${organizationId}:`, JSON.stringify(out));
  }

  console.log('\n✅ cadeia concluída');
  await app.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ cadeia falhou:', error);
    process.exit(1);
  });
