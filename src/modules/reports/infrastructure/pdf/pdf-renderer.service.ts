import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatDateTimeBR } from 'src/shared/domain/formatters';

export type ReportSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: {
    columns: string[];
    rows: string[][];
    /** Peso relativo de cada coluna; default é largura igual. */
    columnWidths?: number[];
  };
};

export type ReportDocument = {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  sections: ReportSection[];
};

/**
 * O texto como a fonte padrão do PDF consegue escrevê-lo.
 *
 * PDFKit sem fonte embutida usa Helvetica com codificação de byte único: o que
 * cai fora dela **não vira outro glifo, some**. Foi assim que a coluna
 * "Variação" saiu em branco num relatório recém-gerado - os formatters de
 * `shared/domain/formatters.ts` devolvem `—` para "não aplicável", e o travessão desaparecia no caminho,
 * deixando a célula vazia. Vazio e "não aplicável" são coisas diferentes, e a
 * segunda estava sendo lida como a primeira. O `•` dos marcadores de lista
 * sumia pelo mesmo motivo, e as listas saíam com um recuo e nada.
 *
 * Os `**` são o outro caso: as seções são escritas com ênfase em markdown, que
 * este renderizador não interpreta - eles chegavam ao papel como dois
 * asteriscos. Aqui saem, porque ninguém lê asterisco como negrito num PDF.
 *
 * A alternativa seria embutir uma fonte Unicode. Vale quando o produto tiver
 * texto que **precise** de glifo fora do Latin-1 (um nome de anúncio em grego,
 * uma moeda com símbolo próprio); enquanto o que se perde é pontuação
 * tipográfica, traduzi-la custa um dicionário e nenhum megabyte.
 */
const UNSUPPORTED_GLYPHS: ReadonlyArray<[RegExp, string]> = [
  [/\*\*/g, ''],
  [/[—–]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, '...'],
  [/•/g, '·'],
  [/\u00a0/g, ' '],
];

function plain(text: string): string {
  return UNSUPPORTED_GLYPHS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/** Largura útil da página, dentro das margens laterais. */
const PAGE_MARGIN = 50;
const TABLE_WIDTH = 500;
const ROW_HEIGHT = 18;

@Injectable()
export class PdfRendererService {
  async render(doc: ReportDocument): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        // `bufferPages`: o rodapé leva "Página X de Y", e Y só existe depois
        // que o conteúdo inteiro já decidiu quantas páginas precisa. Sem isso,
        // o número total teria que ser adivinhado antes de escrever.
        const pdf = new PDFDocument({
          size: 'A4',
          margin: PAGE_MARGIN,
          bufferPages: true,
        });
        const chunks: Buffer[] = [];
        pdf.on('data', (c) => chunks.push(c as Buffer));
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);

        pdf.fontSize(22).text(plain(doc.title));
        if (doc.subtitle) {
          pdf
            .moveDown(0.3)
            .fontSize(12)
            .fillColor('#666')
            .text(plain(doc.subtitle));
          pdf.fillColor('black');
        }
        pdf
          .moveDown(0.5)
          .fontSize(9)
          .fillColor('#888')
          .text(`Gerado em ${formatDateTimeBR(doc.generatedAt)}`);
        pdf.fillColor('black').moveDown(1.2);

        for (const section of doc.sections) {
          pdf.fontSize(15).fillColor('#222').text(plain(section.heading));
          pdf.moveDown(0.4).fillColor('black').fontSize(11);
          for (const p of section.paragraphs ?? []) {
            pdf.text(plain(p));
            pdf.moveDown(0.4);
          }
          for (const b of section.bullets ?? []) {
            pdf.text(plain(`• ${b}`));
          }
          if (section.bullets?.length) pdf.moveDown(0.4);
          if (section.table) {
            this.renderTable(
              pdf,
              section.table.columns,
              section.table.rows,
              section.table.columnWidths,
            );
            pdf.moveDown(0.6);
          }
          pdf.moveDown(0.8);
        }

        this.renderFooters(pdf);
        pdf.end();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * "Página X de Y" em todo página, do primeiro ao último — precisa do
   * documento inteiro já montado (`bufferPages`) para saber quantas existem.
   * `switchToPage` não adiciona página nova, só reabre uma já escrita.
   *
   * O rodapé mora **dentro da margem inferior**, e é exatamente por isso que
   * `margins.bottom` precisa cair para zero enquanto ele é escrito: o PDFKit
   * decide sozinho quando estourou a página comparando `y` com
   * `page.maxY()` (`height - margins.bottom`), e qualquer texto abaixo dessa
   * linha aciona uma página nova automática em vez de só ocupar a margem —
   * foi assim que o rodapé criava uma página extra em branco no fim de todo
   * relatório.
   */
  private renderFooters(pdf: PDFKit.PDFDocument) {
    const range = pdf.bufferedPageRange();

    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      const originalBottomMargin = pdf.page.margins.bottom;
      const y = pdf.page.height - originalBottomMargin + 18;

      pdf.page.margins.bottom = 0;
      pdf
        .fontSize(8)
        .fillColor('#94a3b8')
        .text(`Allva · Página ${i + 1} de ${range.count}`, PAGE_MARGIN, y, {
          width: TABLE_WIDTH,
          align: 'center',
          lineBreak: false,
        });
      pdf.fillColor('black');
      pdf.page.margins.bottom = originalBottomMargin;
    }
  }

  /**
   * Tabela com coordenadas manuais — e por isso, ao contrário do texto solto
   * do resto do documento, não ganha a paginação automática do PDFKit de
   * graça. Uma tabela grande (Top 20, ou uma que começa perto do fim de uma
   * página) desenhava linhas além da margem inferior, fora da área visível,
   * sem erro nem log: o defeito não aparecia até alguém abrir o PDF. Cada
   * linha agora verifica o espaço restante e, se não couber, abre página nova
   * e repete o cabeçalho de colunas — do jeito que quem folheia um PDF espera
   * reencontrar contexto ao virar a página.
   */
  private renderTable(
    pdf: PDFKit.PDFDocument,
    columns: string[],
    rows: string[][],
    columnWidths?: number[],
  ) {
    const weights =
      columnWidths && columnWidths.length === columns.length
        ? columnWidths
        : columns.map(() => 1);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const widths = weights.map((w) => (w / totalWeight) * TABLE_WIDTH);
    const offsets: number[] = [];
    widths.reduce((x, w, i) => {
      offsets[i] = x;
      return x + w;
    }, 0);

    const startX = pdf.x;
    const pageBottom = () => pdf.page.height - pdf.page.margins.bottom;

    const drawHeader = (y: number): number => {
      pdf.fillColor('#444').fontSize(10);
      columns.forEach((c, i) => {
        pdf.text(plain(c), startX + offsets[i], y, {
          width: widths[i] - 6,
          height: ROW_HEIGHT - 4,
          ellipsis: true,
          lineBreak: false,
        });
      });
      pdf
        .moveTo(startX, y + ROW_HEIGHT - 4)
        .lineTo(startX + TABLE_WIDTH, y + ROW_HEIGHT - 4)
        .stroke('#999');
      pdf.fillColor('black');
      return y + ROW_HEIGHT;
    };

    // Não começa uma tabela perto do fim da página: cabeçalho sozinho sem
    // nenhuma linha embaixo é tão inútil quanto a linha cortada que esta
    // paginação existe para evitar.
    if (pdf.y + ROW_HEIGHT * 2 > pageBottom()) pdf.addPage();
    let y = drawHeader(pdf.y);

    for (const row of rows) {
      if (y + ROW_HEIGHT > pageBottom()) {
        pdf.addPage();
        y = drawHeader(pdf.y);
      }

      row.forEach((cell, ci) => {
        pdf.text(plain(String(cell ?? '')), startX + offsets[ci], y, {
          width: widths[ci] - 6,
          height: ROW_HEIGHT - 4,
          ellipsis: true,
          lineBreak: false,
        });
      });
      y += ROW_HEIGHT;
    }

    pdf.y = y + 4;
    pdf.x = startX;
  }
}
