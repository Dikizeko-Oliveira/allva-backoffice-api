import { areDocsEnabled } from './docs-visibility';

describe('areDocsEnabled', () => {
  /**
   * The regression this guards. `/docs`, `/docs-json` and `/scalar` were mounted
   * unconditionally and unauthenticated, so a production deploy published every
   * route, request schema and error code to anyone who asked.
   */
  it('is off in production by default', () => {
    expect(areDocsEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is on outside production by default', () => {
    expect(areDocsEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(areDocsEnabled({ NODE_ENV: 'staging' })).toBe(true);
    expect(areDocsEnabled({})).toBe(true);
  });

  it('lets production opt in explicitly', () => {
    expect(
      areDocsEnabled({ NODE_ENV: 'production', DOCS_ENABLED: 'true' }),
    ).toBe(true);
  });

  it('lets any environment opt out explicitly', () => {
    expect(
      areDocsEnabled({ NODE_ENV: 'development', DOCS_ENABLED: 'false' }),
    ).toBe(false);
  });

  it('tolerates surrounding whitespace in the override', () => {
    expect(
      areDocsEnabled({ NODE_ENV: 'production', DOCS_ENABLED: '  true  ' }),
    ).toBe(true);
  });

  it('falls back to the environment default when the override is not true/false', () => {
    // A typo must not silently open the docs in production. Anything that is not
    // the literal 'true' leaves the production default in force.
    for (const value of ['yes', '1', 'TRUE', '']) {
      expect(
        areDocsEnabled({ NODE_ENV: 'production', DOCS_ENABLED: value }),
      ).toBe(false);
    }
  });
});
