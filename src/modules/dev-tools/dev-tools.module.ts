import { Module } from '@nestjs/common';

/**
 * Ferramental de desenvolvimento.
 *
 * As rotas `POST /dev/analysis/*` saíram em A2-S1 com os motores que elas
 * disparavam (waste e recommendations do v1). O que substitui o ferramental
 * neste sprint é o **seed** — `pnpm seed:ads-v2` —, que popula organização,
 * conta, campanhas, ad sets, anúncios, criativos e séries de
 * `ad_metric_snapshots` com moeda dupla e linhagem. É ele que destrava A2-S2 sem
 * depender do sync real, que só existe em A2-S3.
 *
 * O módulo fica vazio de propósito: quando A2-S4/S5 religarem os motores, os
 * gatilhos manuais voltam aqui, apontando para os jobs com lease de `JobRun`.
 */
@Module({})
export class DevToolsModule {}
