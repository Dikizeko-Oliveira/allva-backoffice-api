import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';
import {
  CONTRACT_LIFECYCLE_JOB,
  CONTRACT_LIFECYCLE_QUEUE,
} from './contract-lifecycle.processor';

const UMA_HORA_MS = 60 * 60 * 1000;

/**
 * De hora em hora, e não uma vez por dia.
 *
 * O que este job move é datado: aditivo que passa a valer, contrato que vence.
 * Diário significaria que a expansão negociada para 1º de janeiro chega em
 * algum momento do dia 1º — e um cliente que contratou assentos a mais bate na
 * cota antiga na primeira hora do dia em que pagou por eles.
 *
 * De hora em hora o pior atraso é uma hora, e o custo é uma varredura de
 * índice numa carteira que tem dezenas de linhas, não milhões.
 */
@Injectable()
export class ContractLifecycleScheduler implements OnModuleInit {
  private readonly logger = new Logger(ContractLifecycleScheduler.name);

  constructor(
    @InjectQueue(CONTRACT_LIFECYCLE_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    if (process.env.CONTRACT_LIFECYCLE_DISABLED === 'true') {
      this.logger.warn('Contract lifecycle scheduler disabled by env flag');
      return;
    }

    const intervalMs = Number(
      process.env.CONTRACT_LIFECYCLE_INTERVAL_MS ?? UMA_HORA_MS,
    );

    await this.queue.add(
      CONTRACT_LIFECYCLE_JOB,
      { limit: 200 },
      {
        repeat: { every: intervalMs },
        removeOnComplete: true,
        removeOnFail: true,
        jobId: 'contract-lifecycle:repeat',
      },
    );

    this.logger.log(
      `Contract lifecycle scheduled every ${intervalMs}ms via queue=${CONTRACT_LIFECYCLE_QUEUE}`,
    );
  }
}
