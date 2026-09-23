import { Injectable } from '@nestjs/common';
import { Preference } from 'src/modules/preferences/domain/entities';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class PreferencesPrismaRepository implements PreferencesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(preference: Preference): Promise<void> {
    await this.prisma.preference.create({
      data: {
        id: preference.id,
        accountId: preference.accountId,
        notificationByEmail: preference.notificationByEmail,
        dailyResume: preference.dailyResume,
        alertNotifications: preference.alertNotifications,
        promotionNotifications: preference.promotionNotifications,
        productNewsNotification: preference.productNewsNotification,
        createdAt: preference.createdAt,
        reviewedAt: preference.reviewedAt,
      },
    });
  }

  async update(preference: Preference): Promise<void> {
    await this.prisma.preference.update({
      where: { id: preference.id },
      data: {
        notificationByEmail: preference.notificationByEmail,
        dailyResume: preference.dailyResume,
        alertNotifications: preference.alertNotifications,
        promotionNotifications: preference.promotionNotifications,
        productNewsNotification: preference.productNewsNotification,
        reviewedAt: preference.reviewedAt,
      },
    });
  }

  async findByAccountId(accountId: string): Promise<Preference | null> {
    const record = await this.prisma.preference.findUnique({
      where: { accountId },
    });

    if (!record) return null;

    return Preference.restore({
      id: record.id,
      accountId: record.accountId,
      notificationByEmail: record.notificationByEmail,
      dailyResume: record.dailyResume,
      alertNotifications: record.alertNotifications,
      promotionNotifications: record.promotionNotifications,
      productNewsNotification: record.productNewsNotification,
      createdAt: record.createdAt,
      reviewedAt: record.reviewedAt,
    });
  }
}
