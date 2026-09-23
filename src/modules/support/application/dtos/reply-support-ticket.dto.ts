import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { SanitizeMultiline } from '../validators/sanitize.transform';
import { SupportTicketMessageDto } from './support-ticket.dto';

/**
 * A resposta do cliente num chamado que já existe.
 *
 * Sem `subject`, `category` ou `priority`: todos já foram decididos na
 * abertura, e reabri-los a cada mensagem faria a conversa poder mudar de
 * assunto no meio — que é exatamente o que um chamado novo resolve melhor.
 *
 * O print opcional **não** está neste DTO: chega como arquivo `screenshot`
 * no mesmo `multipart/form-data`, pelo `FileInterceptor` da rota — o mesmo
 * caminho de `POST /support/messages`. A rota também aceita JSON puro quando
 * não há arquivo.
 */
export class ReplySupportTicketInputDto {
  @ApiProperty({ example: 'Reconectei a credencial e o erro continua.' })
  @SanitizeMultiline()
  @IsString({ message: 'Message must be a string and is required' })
  @MinLength(2, { message: 'Message must have at least 2 characters' })
  @MaxLength(5000, { message: 'Message must have at most 5000 characters' })
  message: string;
}

export class ReplySupportTicketOutputDto {
  @ApiProperty({ type: SupportTicketMessageDto })
  message: SupportTicketMessageDto;

  @ApiProperty({
    example: 'OPEN',
    description:
      'O status do chamado **depois** da resposta. Responder num chamado resolvido o reabre — ver o use case.',
  })
  status: string;
}
