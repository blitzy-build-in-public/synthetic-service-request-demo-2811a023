import { describe, expect, it } from 'vitest';
// Vite leaves the importing file out of its own import.meta.glob results, so this file reaches the email
// scan through a separate raw import of itself.
import ownSource from './architecture.test.ts?raw';

const OWN_PATH = '/src/test/architecture.test.ts';

// Raw source text keyed by root-relative path, such as /src/domain/model.ts. Vite rewrites these calls at
// transform time, so every glob argument must stay a literal. The calls carry no `<string>` type argument:
// the `?raw` query already types each record as Record<string, string>, and Vitest's file-system module cache
// skips only files whose text contains the plain call, so a typed call would keep serving the file list of
// an earlier run and miss files added since.
const productionSources = import.meta.glob(
  ['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.{ts,tsx}', '!/src/test/**'],
  { query: '?raw', import: 'default', eager: true },
);
const allSourceFiles = import.meta.glob('/src/**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const indexHtmlFiles = import.meta.glob('/index.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const packageJsonFiles = import.meta.glob('/package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function singleFile(files: Readonly<Record<string, string>>, path: string): string {
  const source = files[path];
  if (source === undefined) {
    throw new Error(`${path} was not loaded: its import.meta.glob pattern matched nothing.`);
  }
  return source;
}

const indexHtml = singleFile(indexHtmlFiles, '/index.html');
const packageJson = singleFile(packageJsonFiles, '/package.json');

const productionEntries = Object.entries(productionSources);
const productionPaths = productionEntries.map(([path]) => path);
const productionModules = productionEntries.filter(([path]) => /\.tsx?$/.test(path));

/** A production module's place in the dependency order. */
type Layer = 'domain' | 'storage' | 'state' | 'components' | 'app' | 'main' | 'styles';

/** Where an import specifier points: a root-relative module path without extension, or an npm package. */
type ResolvedSpecifier =
  | { readonly kind: 'module'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string };

// One alternation, so whichever comment starts first wins: a `/*` inside a line comment is not taken for a
// block. A `//` right after `:` (a URL scheme) or `\` (an escaped slash in a regex literal) is not a comment.
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/gm;

/** Removes block and line comments, so prose that names a banned identifier cannot fail a check. */
function stripComments(source: string): string {
  return source.replace(COMMENT_PATTERN, (_comment: string, prefix: string | undefined) => prefix ?? ' ');
}

/** Removes `<!-- … -->` comments from HTML. */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

// Import and re-export statements never contain quotes, semicolons, parentheses or `=` before `from`, so the
// lazy run cannot reach past its own statement into a later one.
const FROM_IMPORT_PATTERN = /\b(?:import|export)\b[^'"`;()=]*?\bfrom\s*(['"])([^'"]+)\1/g;
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s*(['"])([^'"]+)\1/g;

/** Every specifier of the static imports and re-exports in `source`, including multi-line named imports. */
function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  for (const pattern of [FROM_IMPORT_PATTERN, SIDE_EFFECT_IMPORT_PATTERN]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/** Resolves `specifier` as written in `fromFile`: relative paths fold `.` and `..`; bare names are packages. */
function resolveSpecifier(fromFile: string, specifier: string): ResolvedSpecifier {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
    return { kind: 'package', name };
  }
  const segments = specifier.startsWith('/') ? [] : fromFile.split('/').filter(Boolean).slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') {
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }
  return { kind: 'module', path: `/${segments.join('/')}` };
}

const LAYER_DIRECTORIES: ReadonlyArray<readonly [string, Layer]> = [
  ['/src/domain/', 'domain'],
  ['/src/storage/', 'storage'],
  ['/src/state/', 'state'],
  ['/src/components/', 'components'],
];
const TOP_LEVEL_LAYERS: Readonly<Record<string, Layer>> = {
  '/src/App.tsx': 'app',
  '/src/main.tsx': 'main',
  '/src/styles.css': 'styles',
};

// Null for a path outside every layer: a new directory gets no import rule, so the suite fails on it
// instead of letting it escape the layering checks.
/** The layer `path` belongs to, from its `/src/<layer>/` directory or its top-level file name. */
function layerOf(path: string): Layer | null {
  const topLevel = TOP_LEVEL_LAYERS[path];
  if (topLevel !== undefined) {
    return topLevel;
  }
  const directory = LAYER_DIRECTORIES.find(([prefix]) => path.startsWith(prefix));
  return directory === undefined ? null : directory[1];
}

const MODULE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** The production file a resolved module path loads, if any. */
function productionFileFor(modulePath: string): string | undefined {
  return MODULE_SUFFIXES.map((suffix) => `${modulePath}${suffix}`).find((candidate) =>
    Object.hasOwn(productionSources, candidate),
  );
}

/** One row of the module layering table. */
interface ImportRule {
  readonly title: string;
  readonly layers: readonly Layer[];
  /** Directories a relative import may resolve into; null allows every production module. */
  readonly modules: readonly string[] | null;
  /** Packages every file of these layers may import; null allows any package. */
  readonly packages: readonly string[] | null;
}

const IMPORT_RULES: readonly ImportRule[] = [
  {
    title: 'domain imports only domain modules and no packages',
    layers: ['domain'],
    modules: ['/src/domain/'],
    packages: [],
  },
  {
    title: 'storage imports only domain and storage modules and no packages',
    layers: ['storage'],
    modules: ['/src/domain/', '/src/storage/'],
    packages: [],
  },
  {
    title: 'state imports only domain, storage and state modules, and React only in StoreContext.tsx',
    layers: ['state'],
    modules: ['/src/domain/', '/src/storage/', '/src/state/'],
    packages: [],
  },
  {
    title: 'components and App import only domain, state and component modules, and no package but react',
    layers: ['components', 'app'],
    modules: ['/src/domain/', '/src/state/', '/src/components/'],
    packages: ['react'],
  },
  {
    title: 'main.tsx, the composition root, may import any production module or package',
    layers: ['main'],
    modules: null,
    packages: null,
  },
];

/** Packages allowed in one file beyond its layer's rule. */
const FILE_PACKAGE_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  '/src/state/StoreContext.tsx': ['react'],
};

/** Each import in `source` that `rule` forbids, described with its specifier. */
function importViolations(file: string, source: string, rule: ImportRule): string[] {
  const packages =
    rule.packages === null ? null : [...rule.packages, ...(FILE_PACKAGE_EXCEPTIONS[file] ?? [])];
  return importSpecifiers(source).flatMap((specifier) => {
    const target = resolveSpecifier(file, specifier);
    if (target.kind === 'package') {
      return packages === null || packages.includes(target.name)
        ? []
        : [`'${specifier}' imports package ${target.name}, which this layer may not use`];
    }
    // Resolving to a real production file also rejects imports of tests and test support from app code.
    if (productionFileFor(target.path) === undefined) {
      return [`'${specifier}' resolves to ${target.path}, which is no production source file`];
    }
    const { modules } = rule;
    if (modules !== null && !modules.some((directory) => target.path.startsWith(directory))) {
      return [`'${specifier}' resolves to ${target.path}, outside ${modules.join(', ')}`];
    }
    return [];
  });
}

/** A banned construct: the name a failure reports, and the pattern that finds it. */
type Ban = readonly [name: string, pattern: RegExp];

// Patterns carry no `g` flag, because a global RegExp keeps `lastIndex` between `test` calls.
/** The names of the bans whose pattern occurs in `code`. */
function bannedUses(code: string, bans: readonly Ban[]): string[] {
  return bans.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

const DOMAIN_BANS: readonly Ban[] = [
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['localStorage', /\blocalStorage\b/],
  ['Date.now(', /\bDate\.now\s*\(/],
  ['new Date(', /\bnew\s+Date\s*\(/],
];

const PRODUCTION_BANS: readonly Ban[] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['dangerouslySetInnerHTML', /\bdangerouslySetInnerHTML\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['document.cookie', /\bdocument\.cookie\b/],
  ['dynamic import(', /\bimport\s*\(/],
];

const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s'"`)>]*/gi;

// Written so that this file's own text, which the email check also scans, holds no match: no local part
// precedes any `@` here.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const HTML_REFERENCE_PATTERN = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Every `src` and `href` value in `html`, quoted or not. */
function htmlReferences(html: string): string[] {
  return Array.from(html.matchAll(HTML_REFERENCE_PATTERN), (match) => match[1] ?? match[2] ?? match[3] ?? '');
}

const CSS_URL_PATTERN = /\burl\(\s*['"]?([^'")\s]*)/gi;

/** True for a plain JSON object: not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HASH_ROUTE_MODULE = '/src/components/useHashRoute.ts';
const LOCAL_STORAGE_OWNERS = ['/src/storage/', '/src/main.tsx'];
const ENTRY_SCRIPT = '/src/main.tsx';
const emailScannedFiles: Readonly<Record<string, string>> = { ...allSourceFiles, [OWN_PATH]: ownSource };

function filesInLayers(layers: readonly Layer[]): Array<[string, string]> {
  return productionModules.filter(([path]) => {
    const layer = layerOf(path);
    return layer !== null && layers.includes(layer);
  });
}

// Runs first in the file: if a glob matched the wrong set, every later check would pass on nothing.
describe('source loading', () => {
  it.each(['/src/domain/', '/src/storage/', '/src/state/', '/src/components/', '/src/App.tsx', '/src/main.tsx'])(
    'production sources include %s',
    (expected) => {
      expect(productionPaths.some((path) => path.startsWith(expected))).toBe(true);
    },
  );

  it('production sources exclude tests and test support', () => {
    expect(productionPaths.filter((path) => path.includes('.test.') || path.startsWith('/src/test/'))).toEqual([]);
  });

  it('the email scan covers tests, test support and this file', () => {
    const scanned = Object.keys(emailScannedFiles);
    expect(scanned).toContain('/src/test/setup.ts');
    expect(scanned).toContain(OWN_PATH);
    expect(scanned.some((path) => path.includes('.test.') && path !== OWN_PATH)).toBe(true);
    expect(ownSource).toContain('EMAIL_PATTERN');
  });

  // Vitest empties CSS it does not process, so a blank text here means a check below would scan nothing.
  it.each(productionEntries)('%s is loaded with its text and belongs to a known layer', (path, source) => {
    expect(source.trim()).not.toBe('');
    expect(layerOf(path)).not.toBeNull();
  });
});

describe('checker helpers', () => {
  it('stripComments removes block and line comments but keeps URL schemes and escaped slashes', () => {
    const source = [
      'const a = 1; // fetch()',
      "/* window\n document */ const b = 'scheme://host';",
      'const c = /\\/\\//;',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/fetch|window|document/);
    expect(stripped).toContain("const b = 'scheme://host';");
    expect(stripped).toContain('const c = /\\/\\//;');
  });

  it('importSpecifiers finds static, type-only, multi-line, re-export and side-effect imports', () => {
    const source = [
      "import { a } from './a';",
      'import type {',
      '  B,',
      '  C,',
      "} from '../b';",
      "export * from './c';",
      "export { d } from 'react-dom/client';",
      "import './d.css';",
      "// import { e } from './commented';",
      'export const f = 1;',
    ].join('\n');
    expect(importSpecifiers(source).sort()).toEqual(['../b', './a', './c', './d.css', 'react-dom/client']);
  });

  it.each<[string, string, ResolvedSpecifier]>([
    ['/src/components/ListView.tsx', '../domain/model', { kind: 'module', path: '/src/domain/model' }],
    ['/src/App.tsx', './components/DemoBanner', { kind: 'module', path: '/src/components/DemoBanner' }],
    ['/src/state/store.ts', './../storage/./localStore', { kind: 'module', path: '/src/storage/localStore' }],
    ['/src/main.tsx', 'react-dom/client', { kind: 'package', name: 'react-dom' }],
    ['/src/main.tsx', '@scope/package/subpath', { kind: 'package', name: '@scope/package' }],
  ])('resolveSpecifier from %s resolves %s', (fromFile, specifier, expected) => {
    expect(resolveSpecifier(fromFile, specifier)).toEqual(expected);
  });

  it.each<[string, Layer | null]>([
    ['/src/domain/model.ts', 'domain'],
    ['/src/storage/localStore.ts', 'storage'],
    ['/src/state/StoreContext.tsx', 'state'],
    ['/src/components/ListView.tsx', 'components'],
    ['/src/App.tsx', 'app'],
    ['/src/main.tsx', 'main'],
    ['/src/styles.css', 'styles'],
    ['/src/utils/helper.ts', null],
  ])('layerOf(%s) is %s', (path, expected) => {
    expect(layerOf(path)).toBe(expected);
  });
});

describe.each(IMPORT_RULES)('$title', (rule) => {
  it.each(filesInLayers(rule.layers))('%s', (file, source) => {
    expect(importViolations(file, source, rule)).toEqual([]);
  });
});

describe('components and App take decisions only from the domain table and changes only through the store', () => {
  it.each(filesInLayers(['components', 'app']))('%s does not reference applyCommand or findRule', (_file, source) => {
    expect(stripComments(source).match(/\b(?:applyCommand|findRule)\b/g) ?? []).toEqual([]);
  });
});

describe('hash routing lives only in useHashRoute.ts', () => {
  it('useHashRoute.ts is a production module', () => {
    expect(productionPaths).toContain(HASH_ROUTE_MODULE);
  });

  it.each(productionEntries.filter(([path]) => path !== HASH_ROUTE_MODULE))(
    '%s does not reference hashchange or location.hash',
    (_file, source) => {
      expect(stripComments(source).match(/\bhashchange\b|\blocation\.hash\b/g) ?? []).toEqual([]);
    },
  );
});

describe('the domain uses no browser API and reads no clock', () => {
  it.each(filesInLayers(['domain']))('%s', (_file, source) => {
    expect(bannedUses(stripComments(source), DOMAIN_BANS)).toEqual([]);
  });
});

describe('no network API, other storage API, HTML injection or dynamic import', () => {
  it.each<[string, string]>([
    ...productionEntries.map(([path, source]): [string, string] => [path, stripComments(source)]),
    ['/index.html', stripHtmlComments(indexHtml)],
  ])('%s', (_file, code) => {
    expect(bannedUses(code, PRODUCTION_BANS)).toEqual([]);
  });
});

describe('no absolute http or https URL', () => {
  it.each<[string, string]>([...productionEntries, ['/index.html', indexHtml]])('%s', (_file, source) => {
    expect(source.match(ABSOLUTE_URL_PATTERN) ?? []).toEqual([]);
  });
});

describe('localStorage is reached only by the storage adapter and the composition root', () => {
  it.each(productionEntries.filter(([path]) => !LOCAL_STORAGE_OWNERS.some((owner) => path.startsWith(owner))))(
    '%s does not reference localStorage',
    (_file, source) => {
      expect(stripComments(source).match(/\blocalStorage\b/g) ?? []).toEqual([]);
    },
  );
});

describe('index.html', () => {
  it('references only the local entry script and data: URIs', () => {
    const references = htmlReferences(stripHtmlComments(indexHtml));
    expect(references).toContain(ENTRY_SCRIPT);
    expect(references.filter((reference) => reference !== ENTRY_SCRIPT && !reference.startsWith('data:'))).toEqual(
      [],
    );
  });
});

// Beyond the http(s) ban: a protocol-relative or local url(), an @import or a web font in a stylesheet would
// fetch more than the page, its script and its stylesheet after load.
describe('stylesheets load no fonts or other resources', () => {
  it.each(productionEntries.filter(([path]) => path.endsWith('.css')))('%s', (_file, source) => {
    const code = stripComments(source);
    const urls = Array.from(code.matchAll(CSS_URL_PATTERN), (match) => match[1] ?? '');
    expect([
      ...bannedUses(code, [
        ['@import', /@import\b/i],
        ['@font-face', /@font-face\b/i],
      ]),
      ...urls.filter((url) => !url.startsWith('data:')).map((url) => `url(${url})`),
    ]).toEqual([]);
  });
});

describe('all data is fictional: no email address in any source or test file', () => {
  it.each(Object.entries(emailScannedFiles))('%s', (_file, source) => {
    expect(source.match(EMAIL_PATTERN) ?? []).toEqual([]);
  });
});

describe('package.json', () => {
  it('declares exactly react and react-dom as runtime dependencies', () => {
    const manifest: unknown = JSON.parse(packageJson);
    if (!isJsonObject(manifest)) {
      throw new Error('package.json does not hold a JSON object.');
    }
    const dependencies = manifest['dependencies'];
    if (!isJsonObject(dependencies)) {
      throw new Error('package.json "dependencies" is not a JSON object.');
    }
    expect(Object.keys(dependencies).sort()).toEqual(['react', 'react-dom']);
  });
});

