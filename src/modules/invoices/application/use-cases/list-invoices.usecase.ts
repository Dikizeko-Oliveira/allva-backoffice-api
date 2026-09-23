import { Injectable } from '@nestjs/common';
import { ListInvoicesOutputDto } from '../dtos';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';

@Injectable()
export class ListInvoicesUseCase {
  constructor(
    private readonly invoicesRepository: InvoicesRepositoryInterface,
  ) {}

  async execute(
    accountId: string,
    period?: '7d' | '30d' | '90d',
  ): Promise<ListInvoicesOutputDto> {
    let since: Date | undefined;

    if (period) {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
      since = new Date();
      since.setDate(since.getDate() - days);
    }

    const invoices = await this.invoicesRepository.listByAccountId(
      accountId,
      since,
    );

    return {
      invoices: invoices.map((invoice) => invoice.toJSON()),
    };
  }
}
