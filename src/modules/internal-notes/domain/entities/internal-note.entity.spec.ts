import { InternalNote } from './internal-note.entity';

const note = (visibilityPermission: string | null = null) =>
  InternalNote.create({
    subjectType: 'ORGANIZATION',
    subjectId: 'org-1',
    authorId: 'author',
    body: 'Cliente pediu contato só à tarde',
    visibilityPermission,
  });

describe('InternalNote', () => {
  it('sem restrição, é visível para quem vê o assunto', () => {
    expect(note().isVisibleTo(() => false)).toBe(true);
  });

  it('restrita, só para quem tem a permissão extra', () => {
    const restricted = note('billing:read');

    expect(restricted.isVisibleTo((p) => p === 'billing:read')).toBe(true);
    expect(restricted.isVisibleTo(() => false)).toBe(false);
  });

  it('apagada some para todos', () => {
    const deleted = note();
    deleted.delete();

    expect(deleted.isVisibleTo(() => true)).toBe(false);
  });

  it('só o autor ou quem modera altera', () => {
    const subject = note();

    expect(subject.canBeChangedBy('author', false)).toBe(true);
    expect(subject.canBeChangedBy('outro', false)).toBe(false);
    expect(subject.canBeChangedBy('outro', true)).toBe(true);
  });

  it('editar carimba editedAt e mantém o que não veio', () => {
    const subject = note();
    subject.edit({ pinned: true });

    expect(subject.pinned).toBe(true);
    expect(subject.body).toBe('Cliente pediu contato só à tarde');
    expect(subject.editedAt).toBeInstanceOf(Date);
  });
});
