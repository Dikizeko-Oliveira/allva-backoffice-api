import { PdfRendererService, ReportDocument } from './pdf-renderer.service';

function baseDoc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    title: 'Relatório de teste',
    subtitle: 'Subtítulo',
    generatedAt: new Date('2026-08-27T12:00:00.000Z'),
    sections: [],
    ...overrides,
  };
}

/**
 * Conta objetos `/Type /Page` (não `/Pages`) no PDF bruto. São dicionários de
 * estrutura, escritos sem compressão mesmo com `compress: true` (só o
 * conteúdo de cada página é comprimido) — por isso dá para contar página sem
 * decodificar o Flate do miolo do documento.
 */
function countPages(buffer: Buffer): number {
  const text = buffer.toString('latin1');
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function manyRows(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [
    `Anúncio ${i}`,
    'META',
    '0.50',
    '0.80',
    'R$ 10,00',
    'R$ 20,00',
  ]);
}

describe('PdfRendererService', () => {
  const renderer = new PdfRendererService();

  it('produces a well-formed PDF buffer', async () => {
    const buffer = await renderer.render(
      baseDoc({
        sections: [{ heading: 'Seção', paragraphs: ['Um parágrafo.'] }],
      }),
    );

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(countPages(buffer)).toBeGreaterThanOrEqual(1);
  });

  it('keeps a small table on a single page', async () => {
    const buffer = await renderer.render(
      baseDoc({
        sections: [
          {
            heading: 'Tabela pequena',
            table: { columns: ['A', 'B'], rows: [['1', '2']] },
          },
        ],
      }),
    );

    expect(countPages(buffer)).toBe(1);
  });

  /**
   * O defeito real: uma tabela grande desenhada com coordenadas manuais
   * escrevia linhas além da margem inferior em vez de virar página. Este teste
   * força uma tabela Top-N grande e confirma que o documento realmente ganhou
   * mais de uma página em vez de estourar a primeira silenciosamente.
   */
  it('breaks a long table across pages instead of overflowing the margin', async () => {
    const buffer = await renderer.render(
      baseDoc({
        sections: [
          {
            heading: 'Tabela grande',
            table: {
              columns: [
                'Anúncio',
                'Plataforma',
                'Score',
                'Conf.',
                'Evitável/dia',
                'Incorrido',
              ],
              rows: manyRows(80),
            },
          },
        ],
      }),
    );

    expect(countPages(buffer)).toBeGreaterThan(1);
  });

  it('never throws on null/undefined table cells', async () => {
    await expect(
      renderer.render(
        baseDoc({
          sections: [
            {
              heading: 'Valores ausentes',
              table: {
                columns: ['A', 'B', 'C'],
                rows: [
                  [
                    'x',
                    null as unknown as string,
                    undefined as unknown as string,
                  ],
                ],
              },
            },
          ],
        }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('renders with custom relative column widths without throwing', async () => {
    await expect(
      renderer.render(
        baseDoc({
          sections: [
            {
              heading: 'Larguras customizadas',
              table: {
                columns: ['Nome bem longo', 'Curta'],
                rows: [['Um valor qualquer bem comprido para testar', '1']],
                columnWidths: [3, 1],
              },
            },
          ],
        }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('renders a document with no sections at all', async () => {
    const buffer = await renderer.render(baseDoc());
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
