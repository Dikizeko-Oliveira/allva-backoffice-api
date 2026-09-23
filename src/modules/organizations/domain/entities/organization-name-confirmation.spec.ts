import { Organization } from './organization.entity';

/**
 * Quando o nome de uma organização é "declarado por um humano".
 *
 * A distinção existe por causa do e-mail de convite — o único lugar onde
 * terceiros leem esse nome. "Fulano convidou você para participar da
 * organização Kevin de Oliveira" é o custo de a organização passar a nascer
 * junto com a conta, e o rename é pedido no momento em que esse custo aparece,
 * não no cadastro.
 */
describe('confirmação do nome da organização', () => {
  it('o nome derivado do cadastro nasce provisório', () => {
    const organization = Organization.create({
      ownerId: 'acc-1',
      name: 'Kevin de Oliveira',
    });

    expect(organization.hasProvisionalName()).toBe(true);
    expect(organization.nameConfirmedAt).toBeNull();
  });

  it('o nome digitado no modal nasce confirmado', () => {
    const organization = Organization.create({
      ownerId: 'acc-1',
      name: 'Allva LTDA',
      nameConfirmed: true,
    });

    expect(organization.hasProvisionalName()).toBe(false);
    expect(organization.nameConfirmedAt).toBeInstanceOf(Date);
  });

  it('renomear confirma', () => {
    const organization = Organization.create({
      ownerId: 'acc-1',
      name: 'Kevin de Oliveira',
    });

    organization.update({ name: 'Agência Zona Sul' });

    expect(organization.name).toBe('Agência Zona Sul');
    expect(organization.hasProvisionalName()).toBe(false);
  });

  it('reenviar o mesmo nome também confirma', () => {
    /**
     * O formulário chega pré-preenchido: submeter sem editar é dizer "está bom
     * assim". Exigir mudança para carimbar faria a tela perguntar de novo a
     * quem já respondeu — o incômodo que este campo existe para evitar.
     */
    const organization = Organization.create({
      ownerId: 'acc-1',
      name: 'Kevin de Oliveira',
    });

    organization.update({ name: 'Kevin de Oliveira' });

    expect(organization.hasProvisionalName()).toBe(false);
  });

  it('editar outro campo não confirma o nome', () => {
    // Preencher CNPJ não é opinião sobre o nome.
    const organization = Organization.create({
      ownerId: 'acc-1',
      name: 'Kevin de Oliveira',
    });

    organization.update({ cnpj: '12.345.678/0001-99' });

    expect(organization.hasProvisionalName()).toBe(true);
  });

  it('uma organização restaurada preserva o carimbo', () => {
    const confirmedAt = new Date('2026-08-01T10:00:00.000Z');
    const organization = Organization.restore({
      id: 'org-1',
      ownerId: 'acc-1',
      name: 'Allva LTDA',
      createdAt: new Date('2026-07-01T10:00:00.000Z'),
      nameConfirmedAt: confirmedAt,
    });

    expect(organization.hasProvisionalName()).toBe(false);
    expect(organization.nameConfirmedAt).toEqual(confirmedAt);
  });
});
