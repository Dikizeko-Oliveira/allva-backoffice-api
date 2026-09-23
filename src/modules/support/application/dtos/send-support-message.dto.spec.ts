import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SendSupportMessageInputDto } from './send-support-message.dto';

function parse(body: Record<string, unknown>) {
  const dto = plainToInstance(SendSupportMessageInputDto, body);
  return { dto, errors: validateSync(dto) };
}

describe('SendSupportMessageInputDto', () => {
  it('aceita assunto e mensagem válidos', () => {
    const { errors } = parse({
      subject: 'Não consigo conectar minha conta',
      message: 'O botão de conectar não responde depois do login.',
    });

    expect(errors).toEqual([]);
  });

  it('recusa payload sem assunto nem mensagem', () => {
    const { errors } = parse({});

    const properties = errors.map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(['subject', 'message']));
  });

  it('recusa assunto vazio', () => {
    const { errors } = parse({ subject: '', message: 'Mensagem válida.' });

    expect(errors.some((error) => error.property === 'subject')).toBe(true);
  });

  it('recusa mensagem vazia', () => {
    const { errors } = parse({ subject: 'Assunto válido', message: '' });

    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });

  it('recusa assunto e mensagem só com espaço — sanitização reduz a vazio', () => {
    const { errors } = parse({ subject: '   ', message: '   ' });

    const properties = errors.map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(['subject', 'message']));
  });

  it('recusa assunto acima de 200 caracteres', () => {
    const { errors } = parse({
      subject: 'a'.repeat(201),
      message: 'Mensagem válida.',
    });

    expect(errors.some((error) => error.property === 'subject')).toBe(true);
  });

  it('recusa mensagem acima de 5000 caracteres', () => {
    const { errors } = parse({
      subject: 'Assunto válido',
      message: 'a'.repeat(5001),
    });

    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });

  it('sanitiza colchetes angulares — segunda camada de defesa contra HTML', () => {
    const { dto } = parse({
      subject: '<script>alert(1)</script> assunto',
      message: 'texto com <b>tag</b> no meio',
    });

    expect(dto.subject).not.toContain('<');
    expect(dto.message).not.toContain('<');
  });
});
