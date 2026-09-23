import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SupportTicketCategory,
  SupportTicketCategoryValues,
  SupportTicketPriority,
  SupportTicketPriorityValues,
} from 'src/modules/support/domain/entities';
import {
  SanitizeMultiline,
  SanitizeText,
} from '../validators/sanitize.transform';

export class SendSupportMessageInputDto {
  @ApiProperty({ example: 'Não consigo conectar minha conta do Meta' })
  @SanitizeText()
  @IsString({ message: 'Subject must be a string and is required' })
  @MinLength(2, { message: 'Subject must have at least 2 characters' })
  @MaxLength(200, { message: 'Subject must have at most 200 characters' })
  subject: string;

  @ApiProperty({
    example: 'O botão de conectar não responde depois do login.',
  })
  @SanitizeMultiline()
  @IsString({ message: 'Message must be a string and is required' })
  @MinLength(2, { message: 'Message must have at least 2 characters' })
  @MaxLength(5000, { message: 'Message must have at most 5000 characters' })
  message: string;

  @ApiProperty({
    example: 'TECHNICAL',
    enum: SupportTicketCategoryValues,
    required: false,
    default: 'GENERAL',
    description:
      'Opcional — sem ela o chamado nasce GENERAL, o mesmo default do banco.',
  })
  @IsOptional()
  @IsIn(SupportTicketCategoryValues, {
    message: `Category must be one of: ${SupportTicketCategoryValues.join(', ')}`,
  })
  category?: SupportTicketCategory;

  @ApiProperty({
    example: 'HIGH',
    enum: SupportTicketPriorityValues,
    required: false,
    description:
      'Opcional — a urgência declarada por quem abre. Sem ela, a prioridade sai do plano (HIGH com `support-priority`, MEDIUM sem). **Declarar não fura fila:** sem `support-priority` o valor é limitado a MEDIUM.',
  })
  @IsOptional()
  @IsIn(SupportTicketPriorityValues, {
    message: `Priority must be one of: ${SupportTicketPriorityValues.join(', ')}`,
  })
  priority?: SupportTicketPriority;
}

export class SendSupportMessageOutputDto {
  @ApiProperty({ example: true })
  sent: true;

  @ApiProperty({ example: 'SUP-20260828-7K4N' })
  ticketCode: string;

  @ApiProperty({ example: true })
  attachmentUploaded: boolean;

  @ApiProperty({
    example: 'HIGH',
    enum: SupportTicketPriorityValues,
    description:
      'A prioridade **efetiva** do chamado. Pode ser menor que a declarada — ver `priority` na entrada.',
  })
  priority: SupportTicketPriority;

  @ApiProperty({ example: '2026-08-28T14:32:00.000Z' })
  sentAt: Date;
}
