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

/** The lexical grammar `stripComments` reads a source file with. */
type SourceSyntax = 'ts' | 'tsx' | 'css';

/** The grammar of the source file at `path`, from its extension. */
function syntaxOf(path: string): SourceSyntax {
  if (path.endsWith('.css')) {
    return 'css';
  }
  return path.endsWith('.tsx') ? 'tsx' : 'ts';
}

/** The 1-based line of `source` that `index` falls on; a CRLF, LF, CR, U+2028 or U+2029 each ends one line. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r\n|[\n\r\u2028\u2029]/).length;
}

/** The error for a construct opened at `start` and still open at the end of `source`. */
function unterminated(construct: string, source: string, start: number): Error {
  return new Error(`Unterminated ${construct} starting on line ${lineOf(source, start)}.`);
}

const WHITESPACE = /\s/;
// ECMAScript's line terminators. Each ends a line comment, none may stand in a regular expression literal, and
// one before a `++`, `--` or `!` makes it prefix.
const LINE_BREAK = /[\n\r\u2028\u2029]/;
// The line breaks a quoted string cannot hold unescaped. Since ES2019 a script string may hold U+2028 and U+2029,
// and CSS reads neither as a newline, so a string in either grammar runs on past them.
const STRING_LINE_BREAK = /[\n\r]/;
const DIGIT = /\d/;
const IDENTIFIER_START = /[A-Za-z_$\u0080-\uffff]/;
// U+2028 and U+2029 are line terminators, so a word ends before them: one that took them in would hide the line
// break after it from the postfix decision.
const IDENTIFIER_PART = /[\w$\u0080-\u2027\u202a-\uffff]/;
const NUMBER_PART = /[\w$.]/;
const CSS_NAME_PART = /[\w\-\u0080-\uffff]/;

/** The length of the backslash escape at `index`, which takes a CRLF line continuation whole. */
function escapeLength(source: string, index: number): number {
  return source.startsWith('\r\n', index + 1) ? 3 : 2;
}

/** The index just past the quoted string opening at `start`; only a backslash escape carries it over a line break. */
function endOfString(source: string, start: number, construct: string): number {
  const quote = source.charAt(start);
  let index = start + 1;
  for (let char = source.charAt(index); char !== quote; char = source.charAt(index)) {
    if (char === '' || STRING_LINE_BREAK.test(char)) {
      throw unterminated(construct, source, start);
    }
    index += char === '\\' ? escapeLength(source, index) : 1;
  }
  return index + 1;
}

// A `/` right after one of these keywords starts an operand, so it opens a regular expression literal. `of` is
// not one of them: it is no reserved word, and outside a `for (… of …)` head it names a variable a `/` divides.
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'default',
  'do',
  'else',
  'yield',
  'await',
]);

// A `(` right after one of these keywords opens a statement head, not a call or a group: the statement its `)`
// closes the head of may open with a regular expression.
const STATEMENT_HEAD_KEYWORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);

/** What a `(` opened: a call or group, a statement head, or a `for` head with no `;` taken inside it yet. */
type ParenKind = 'call' | 'head' | 'forHead';

// Sticky, so it matches only at its `lastIndex`. A .tsx file writes a generic arrow function's type parameters
// as `<T,>` or `<T extends …>`, which TypeScript does not read as an element.
const TYPE_PARAMETERS_PATTERN = /[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*(?:\s*,|\s+extends\b)/y;

/** `source` without its TypeScript comments; strings, templates, regular expressions and JSX text stay verbatim. */
function stripScriptComments(source: string, jsx: boolean): string {
  let output = '';
  let index = 0;

  /** Copies the next `count` characters. */
  function take(count: number): void {
    output += source.slice(index, index + count);
    index += count;
  }

  /** Copies characters while they match `pattern`, and returns them. */
  function takeWhile(pattern: RegExp): string {
    const start = index;
    while (pattern.test(source.charAt(index))) {
      index += 1;
    }
    output += source.slice(start, index);
    return source.slice(start, index);
  }

  /** Drops the comment at `index`, if one starts there; a block comment leaves a space between its neighbours. */
  function skipComment(): boolean {
    if (source.startsWith('//', index)) {
      // Any line terminator ends it, not only LF: code after a CR, U+2028 or U+2029 runs. The terminator stays, so
      // a CRLF reaches the output whole.
      index += 2;
      while (index < source.length && !LINE_BREAK.test(source.charAt(index))) {
        index += 1;
      }
      return true;
    }
    if (!source.startsWith('/*', index)) {
      return false;
    }
    const end = source.indexOf('*/', index + 2);
    if (end === -1) {
      throw unterminated('block comment', source, index);
    }
    output += ' ';
    index = end + 2;
    return true;
  }

  /** Copies the template literal at `index`, scanning each `${…}` substitution as code. */
  function takeTemplate(): void {
    const start = index;
    take(1);
    for (let char = source.charAt(index); char !== '`'; char = source.charAt(index)) {
      if (char === '') {
        throw unterminated('template literal', source, start);
      }
      if (source.startsWith('${', index)) {
        take(2);
        scanCode('template literal substitution', index - 2);
      } else {
        take(char === '\\' ? escapeLength(source, index) : 1);
      }
    }
    take(1);
  }

  /** Copies the regular expression literal at `index` and its flags; a `/` inside a `[…]` class does not end it. */
  function takeRegex(): void {
    const start = index;
    let inClass = false;
    take(1);
    for (let char = source.charAt(index); inClass || char !== '/'; char = source.charAt(index)) {
      const length = char === '\\' ? 2 : 1;
      const unit = source.slice(index, index + length);
      if (unit.length < length || LINE_BREAK.test(unit)) {
        throw unterminated('regular expression literal', source, start);
      }
      if (char === '[') {
        inClass = true;
      } else if (char === ']') {
        inClass = false;
      }
      take(length);
    }
    take(1);
    takeWhile(IDENTIFIER_PART);
  }

  /** True when the `<` at `at` is followed by a tag name or, for a fragment, by `>`. */
  function startsJsxTag(at: number): boolean {
    const next = source.charAt(at + 1);
    return next === '>' || IDENTIFIER_START.test(next);
  }

  /** True when the `<` at `index` opens a JSX element rather than generic type parameters. */
  function opensJsxElement(): boolean {
    TYPE_PARAMETERS_PATTERN.lastIndex = index + 1;
    return startsJsxTag(index) && !TYPE_PARAMETERS_PATTERN.test(source);
  }

  /** Copies the TypeScript type arguments a JSX tag passes, as in `<Select<Option> …>`, through their `>`. */
  function takeTypeArguments(): void {
    const start = index;
    let depth = 0;
    do {
      const char = source.charAt(index);
      if (char === '') {
        throw unterminated('JSX type argument list', source, start);
      }
      if (skipComment()) {
        continue;
      }
      if (char === "'" || char === '"') {
        take(endOfString(source, index, 'string literal') - index);
      } else if (char === '`') {
        takeTemplate();
      } else if (source.startsWith('=>', index)) {
        take(2);
      } else {
        if (char === '<') {
          depth += 1;
        } else if (char === '>') {
          depth -= 1;
        }
        take(1);
      }
    } while (depth > 0);
  }

  /** Copies the JSX element or fragment at `index`: its tag, its children and its closing tag. */
  function takeJsxElement(): void {
    const start = index;
    let afterEquals = false;
    take(1);
    for (let char = source.charAt(index); char !== '>'; char = source.charAt(index)) {
      if (char === '') {
        throw unterminated('JSX element', source, start);
      }
      if (skipComment()) {
        continue;
      }
      if (source.startsWith('/>', index)) {
        take(2);
        return;
      }
      if (char === '"' || char === "'") {
        // JSX attribute strings have no escapes and may span lines.
        const end = source.indexOf(char, index + 1);
        if (end === -1) {
          throw unterminated('JSX attribute string', source, index);
        }
        take(end + 1 - index);
      } else if (char === '{') {
        take(1);
        scanCode('JSX expression', index - 1);
      } else if (char === '<') {
        // An element is an attribute's value only right after its `=`; a `<` anywhere else opens type arguments.
        if (afterEquals && startsJsxTag(index)) {
          takeJsxElement();
        } else {
          takeTypeArguments();
        }
      } else {
        take(1);
      }
      if (!WHITESPACE.test(char)) {
        afterEquals = char === '=';
      }
    }
    take(1);
    // Children are text, kept whole: an apostrophe or `//` in them opens no string or comment.
    for (let char = source.charAt(index); !source.startsWith('</', index); char = source.charAt(index)) {
      if (char === '') {
        throw unterminated('JSX element', source, start);
      }
      if (char === '{') {
        take(1);
        scanCode('JSX expression', index - 1);
      } else if (char === '<') {
        if (!startsJsxTag(index)) {
          throw new Error(`Unexpected < in JSX text on line ${lineOf(source, index)}.`);
        }
        takeJsxElement();
      } else {
        take(1);
      }
    }
    const end = source.indexOf('>', index + 2);
    if (end === -1) {
      throw unterminated('JSX element', source, start);
    }
    take(end + 1 - index);
  }

  /** Scans code to the end of `source`, or through the `}` closing the `construct` opened at `openedAt`. */
  function scanCode(construct: string | null, openedAt: number): void {
    let depth = 0;
    // True where an operand may start: there a `/` opens a regular expression and a `<` may open an element.
    let operandMayStart = true;
    // The statement head keyword just taken, or the `await` of `for await`; comments and whitespace keep it.
    let headKeyword = '';
    // One entry per `(` still open in this frame, naming what it opened. Only a `for` head holds the `of` of
    // `for (… of …)`, and a `;` taken directly inside it shows a classic `for (…; …; …)` head, which cannot.
    const openParens: ParenKind[] = [];
    // True right after a `.`, including that of `?.`, or a `#`: a word there is a member name, even one spelt
    // like a keyword, so it ends an operand.
    let memberNameNext = false;
    // True when a line break, or a block comment holding one, separates the next token from the previous one.
    let lineBreakBefore = false;
    for (let char = source.charAt(index); char !== ''; char = source.charAt(index)) {
      const gapStart = index;
      if (skipComment()) {
        lineBreakBefore = lineBreakBefore || LINE_BREAK.test(source.slice(gapStart, index));
        continue;
      }
      if (WHITESPACE.test(char)) {
        lineBreakBefore = lineBreakBefore || LINE_BREAK.test(char);
        take(1);
        continue;
      }
      const previousHeadKeyword = headKeyword;
      const memberName = memberNameNext;
      // TypeScript reads a `++`, `--` or `!` as postfix only on the line of the operand it follows. The type is
      // written out because the loop assigns `operandMayStart` from this value, which would make inference circular.
      const postfix: boolean = !operandMayStart && !lineBreakBefore;
      headKeyword = '';
      memberNameNext = false;
      lineBreakBefore = false;
      if (char === "'" || char === '"') {
        take(endOfString(source, index, 'string literal') - index);
        operandMayStart = false;
      } else if (char === '`') {
        takeTemplate();
        operandMayStart = false;
      } else if (char === '/' && operandMayStart) {
        takeRegex();
        operandMayStart = false;
      } else if (jsx && char === '<' && operandMayStart && opensJsxElement()) {
        takeJsxElement();
        operandMayStart = false;
      } else if (IDENTIFIER_START.test(char)) {
        const word = takeWhile(IDENTIFIER_PART);
        const keyword = memberName ? '' : word;
        // `of` is a keyword only directly inside a `for (… of …)` or `for await (… of …)` head. In a call or group,
        // an `if`, `while` or `with` head, or a `for` head past its first `;`, it names a variable a `/` divides.
        operandMayStart = REGEX_KEYWORDS.has(keyword) || (keyword === 'of' && openParens.at(-1) === 'forHead');
        if (STATEMENT_HEAD_KEYWORDS.has(keyword) || (keyword === 'await' && previousHeadKeyword === 'for')) {
          headKeyword = keyword;
        }
      } else if (DIGIT.test(char)) {
        takeWhile(NUMBER_PART);
        operandMayStart = false;
      } else if (char === '}' && depth === 0) {
        if (construct === null) {
          throw new Error(`Unbalanced } on line ${lineOf(source, index)}.`);
        }
        take(1);
        return;
      } else if (source.startsWith('...', index)) {
        // A spread is no member access: the word after it may be a keyword such as `typeof`.
        take(3);
        operandMayStart = true;
      } else if (source.startsWith('++', index) || source.startsWith('--', index)) {
        // A postfix `++` or `--` leaves its operand ended, so a `/` after it divides; a prefix one awaits an operand.
        take(2);
        operandMayStart = !postfix;
      } else if (char === '!' && postfix && source.charAt(index + 1) !== '=') {
        // TypeScript's non-null assertion, which leaves its operand ended.
        take(1);
        operandMayStart = false;
      } else {
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
        } else if (char === '(') {
          if (previousHeadKeyword === '') {
            openParens.push('call');
          } else {
            // `await` is a head keyword only as that of `for await`, whose head is a `for` head too.
            openParens.push(previousHeadKeyword === 'for' || previousHeadKeyword === 'await' ? 'forHead' : 'head');
          }
        } else if (char === ';' && openParens.length > 0 && openParens.at(-1) === 'forHead') {
          openParens[openParens.length - 1] = 'head';
        }
        take(1);
        memberNameNext = char === '.' || char === '#';
        // `]` and most `)` end an operand. The `)` closing an `if`, `while`, `for` or `with` head does not: a
        // statement follows it, as one may follow a `}` that ends a block, and either may open with a regular
        // expression. Misreading the rarer division after an object literal keeps text verbatim, where the opposite
        // mistake would let a quote or `/*` inside a real regular expression open a string or comment.
        operandMayStart = char === ')' ? (openParens.pop() ?? 'call') !== 'call' : char !== ']';
      }
    }
    if (construct !== null) {
      throw unterminated(construct, source, openedAt);
    }
  }

  scanCode(null, 0);
  return output;
}

/** The index just past the `)` of the `url(` at `open`, or of the quote that opens its string argument. */
function endOfCssUrl(source: string, open: number, start: number): number {
  let index = open + 1;
  while (WHITESPACE.test(source.charAt(index))) {
    index += 1;
  }
  const first = source.charAt(index);
  if (first === "'" || first === '"') {
    return index;
  }
  for (let char = first; char !== ')'; char = source.charAt(index)) {
    if (char === '') {
      throw unterminated('CSS url( token', source, start);
    }
    index += char === '\\' ? escapeLength(source, index) : 1;
  }
  return index + 1;
}

/** `source` without its CSS comments; strings, escapes and unquoted `url(…)` stay verbatim, and `//` is text. */
function stripCssComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const start = index;
    const char = source.charAt(index);
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        throw unterminated('CSS comment', source, index);
      }
      output += ' ';
      index = end + 2;
      continue;
    }
    if (char === '\\') {
      index += escapeLength(source, index);
    } else if (char === "'" || char === '"') {
      index = endOfString(source, index, 'CSS string');
    } else if (CSS_NAME_PART.test(char)) {
      while (CSS_NAME_PART.test(source.charAt(index))) {
        index += 1;
      }
      if (source.slice(start, index).toLowerCase() === 'url' && source.charAt(index) === '(') {
        index = endOfCssUrl(source, index, start);
      }
    } else {
      index += 1;
    }
    output += source.slice(start, index);
  }
  return output;
}

/**
 * `source` without its comments, read as `syntax`. Strings, templates, regular expressions, JSX text and CSS
 * `url(…)` stay verbatim, so prose naming a banned identifier fails no check and a quoted comment delimiter hides
 * no code. A block comment becomes a space; a line comment goes, its line break kept. Throws when a literal,
 * comment or JSX element is still open at the end, because the scan would then be out of step with the file.
 */
function stripComments(source: string, syntax: SourceSyntax): string {
  return syntax === 'css' ? stripCssComments(source) : stripScriptComments(source, syntax === 'tsx');
}

// The HTML parser reads these elements' content as text up to their end tag, so a `<!--` there opens no comment.
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
// Sticky, so each matches only at its `lastIndex`.
const HTML_TAG_OPEN_PATTERN = /<(\/?)([A-Za-z][^\s/>]*)/y;
const HTML_BOGUS_COMMENT_PATTERN = /<(?:[!?]|\/(?![A-Za-z>]))/y;

/** The index just past the comment opening at `start`, closed where the HTML parser closes it. */
function endOfHtmlComment(html: string, start: number): number {
  const body = start + 4;
  if (html.startsWith('>', body)) {
    return body + 1;
  }
  if (html.startsWith('->', body)) {
    return body + 2;
  }
  const close = html.indexOf('-->', body);
  const bangClose = html.indexOf('--!>', body);
  if (close === -1 && bangClose === -1) {
    throw unterminated('HTML comment', html, start);
  }
  return bangClose !== -1 && (close === -1 || bangClose < close) ? bangClose + 4 : close + 3;
}

/** The index just past the `>` ending the tag opened at `start`; a quoted attribute value may hold a `>`. */
function endOfHtmlTag(html: string, index: number, start: number): number {
  let position = index;
  for (let char = html.charAt(position); char !== '>'; char = html.charAt(position)) {
    if (char === '') {
      throw unterminated('HTML tag', html, start);
    }
    position += 1;
    if (char === '=') {
      while (WHITESPACE.test(html.charAt(position))) {
        position += 1;
      }
      const quote = html.charAt(position);
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, position + 1);
        if (close === -1) {
          throw unterminated('HTML attribute value', html, position);
        }
        position = close + 1;
      }
    }
  }
  return position + 1;
}

/** Where the content of raw-text element `name`, starting at `index`, ends: at its end tag, or at the end of `html`. */
function endOfRawText(html: string, index: number, name: string): number {
  if (name === 'plaintext') {
    return html.length;
  }
  const endTag = new RegExp(`</${name}[\\s/>]`, 'gi');
  endTag.lastIndex = index;
  return endTag.exec(html)?.index ?? html.length;
}

/** `html` without its `<!-- … -->` comments; tags, attribute values, bogus comments and raw text stay verbatim. */
function stripHtmlComments(html: string): string {
  let output = '';
  let index = 0;
  while (index < html.length) {
    const start = index;
    if (html.startsWith('<!--', index)) {
      index = endOfHtmlComment(html, index);
      output += ' ';
      continue;
    }
    HTML_TAG_OPEN_PATTERN.lastIndex = index;
    HTML_BOGUS_COMMENT_PATTERN.lastIndex = index;
    const tag = HTML_TAG_OPEN_PATTERN.exec(html);
    if (tag !== null) {
      index = endOfHtmlTag(html, index + tag[0].length, start);
      const name = (tag[2] ?? '').toLowerCase();
      if (tag[1] === '' && RAW_TEXT_ELEMENTS.has(name)) {
        index = endOfRawText(html, index, name);
      }
    } else if (HTML_BOGUS_COMMENT_PATTERN.test(html)) {
      // A bogus comment such as <!doctype …> ends at its first `>`, quotes or no quotes.
      const end = html.indexOf('>', index);
      index = end === -1 ? html.length : end + 1;
    } else {
      index += 1;
    }
    output += html.slice(start, index);
  }
  return output;
}

// Import and re-export statements never contain quotes, semicolons, parentheses or `=` before `from`, so the
// lazy run cannot reach past its own statement into a later one.
const FROM_IMPORT_PATTERN = /\b(?:import|export)\b[^'"`;()=]*?\bfrom\s*(['"])([^'"]+)\1/g;
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s*(['"])([^'"]+)\1/g;

/** Every specifier of the static imports and re-exports in `source`, including multi-line named imports. */
function importSpecifiers(source: string, syntax: SourceSyntax): string[] {
  const code = stripComments(source, syntax);
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
  return importSpecifiers(source, syntaxOf(file)).flatMap((specifier) => {
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

const STYLESHEET_BANS: readonly Ban[] = [
  ['@import', /@import\b/i],
  ['@font-face', /@font-face\b/i],
];

/** Each `@import`, `@font-face` and non-`data:` `url(…)` in stylesheet `source`, outside its comments. */
function stylesheetViolations(source: string): string[] {
  const code = stripComments(source, 'css');
  const urls = Array.from(code.matchAll(CSS_URL_PATTERN), (match) => match[1] ?? '');
  return [
    ...bannedUses(code, STYLESHEET_BANS),
    ...urls.filter((url) => !url.startsWith('data:')).map((url) => `url(${url})`),
  ];
}

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
  it.each<[SourceSyntax, string, string]>([
    ['ts', 'const a = 1; // fetch()', 'const a = 1; '],
    ['ts', "/* window\n document */ const b = 'scheme://host';", "  const b = 'scheme://host';"],
    ['ts', 'const c = /\\/\\//; // window', 'const c = /\\/\\//; '],
    ['ts', '/** Calls fetch( and reads window.document. */\nexport const d = 1;', ' \nexport const d = 1;'],
    ['ts', 'const e = a / b; // fetch()', 'const e = a / b; '],
    ['ts', 'const f = (a + b) / c[0] / 2; // fetch()', 'const f = (a + b) / c[0] / 2; '],
    ['ts', 'const g = `${/* fetch( */ value}${value // window\n}`;', 'const g = `${  value}${value \n}`;'],
    ['tsx', "const h = <p>{/* fetch( */}Don't // keep</p>;", "const h = <p>{ }Don't // keep</p>;"],
    ['tsx', 'const i = <a /* window */ href="#">x</a> / 1; // fetch()', 'const i = <a   href="#">x</a> / 1; '],
    ['tsx', 'const j = <T,>(value: T) => value / 2; // fetch()', 'const j = <T,>(value: T) => value / 2; '],
    [
      'tsx',
      'const k = <T extends object>(value: T) => value; // window',
      'const k = <T extends object>(value: T) => value; ',
    ],
    [
      'tsx',
      "const l = <List<'a' | 'b'> label=\"x\" /* fetch( */ />; // window",
      "const l = <List<'a' | 'b'> label=\"x\"   />; ",
    ],
    ['tsx', 'const m = <A b=<i>x</i> /* fetch( */ />;', 'const m = <A b=<i>x</i>   />;'],
    ['ts', 'if /* ready */ (ready) /[/*]/.test(mark); // fetch()', 'if   (ready) /[/*]/.test(mark); '],
    ['ts', 'if (x) { y = (a + b) / c; } // fetch()', 'if (x) { y = (a + b) / c; } '],
    ['ts', 'const n = f(a) / 2; // fetch()', 'const n = f(a) / 2; '],
    ['ts', 'const n = counter++ / 2; // fetch()', 'const n = counter++ / 2; '],
    ['ts', 'const n = counter-- / 2; // fetch()', 'const n = counter-- / 2; '],
    ['ts', 'const n = value! / total; // fetch()', 'const n = value! / total; '],
    ['ts', 'const n = options.in / 2; // fetch()', 'const n = options.in / 2; '],
    ['ts', 'const n = node?.return / 2; // fetch()', 'const n = node?.return / 2; '],
    ['ts', 'const n = this.#in / 2; // fetch()', 'const n = this.#in / 2; '],
    ['ts', 'const n = items.with(0, a) / 2; // fetch()', 'const n = items.with(0, a) / 2; '],
    ['ts', 'const n = [...typeof /[/*]/]; // fetch()', 'const n = [...typeof /[/*]/]; '],
    ['ts', 'const of = 4; const h = of / 2; // fetch()', 'const of = 4; const h = of / 2; '],
    ['ts', 'const n = half(of / 2); // fetch()', 'const n = half(of / 2); '],
    ['ts', 'if (of / 2 > 1) {} // fetch()', 'if (of / 2 > 1) {} '],
    ['ts', 'while (of / 2 > 1) {} // fetch()', 'while (of / 2 > 1) {} '],
    ['ts', 'for (let i = 0; i < of / 2; i += 1) {} // fetch()', 'for (let i = 0; i < of / 2; i += 1) {} '],
    [
      'css',
      'a { color: red; } /* @import */ b { background: url(data:,x); } // kept',
      'a { color: red; }   b { background: url(data:,x); } // kept',
    ],
  ])('stripComments as %s removes the comments of %j and keeps its code and literals', (syntax, source, expected) => {
    expect(stripComments(source, syntax)).toBe(expected);
  });

  // Each source puts a comment delimiter inside a literal or JSX text and a forbidden construct after it. None
  // holds a comment, so stripping must return it unchanged and the check must still find the construct.
  it.each<[string, SourceSyntax, string, readonly Ban[], string[]]>([
    [
      'a line comment delimiter in a string',
      'ts',
      "export const load = () => { const marker = '//'; return fetch(marker); };",
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in strings',
      'ts',
      'const open = "/*"; const width = window.innerWidth; const close = "*/";',
      DOMAIN_BANS,
      ['window'],
    ],
    [
      'comment delimiters in a template and its substitution',
      'ts',
      "const marker = `//${'/*'}`; localStorage.clear(); const close = '*/';",
      DOMAIN_BANS,
      ['localStorage'],
    ],
    [
      'a string in an object literal in a nested template',
      'ts',
      "const label = `a${`b${{ mark: '//' }.mark}`}c`; const reply = fetch(label);",
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in regular expression classes',
      'ts',
      'const opens = /[/*]/; const jar = document.cookie; const closes = /[*/]/;',
      PRODUCTION_BANS,
      ['document.cookie'],
    ],
    [
      'an escaped slash before a quantifier',
      'ts',
      "const slashes = /\\/*/; const jar = document.cookie; const close = '*/';",
      PRODUCTION_BANS,
      ['document.cookie'],
    ],
    [
      'a quote in a regular expression after a block',
      'ts',
      "if (ready) { run(); } /'/.test(mark); const marker = '//'; fetch(marker);",
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'a quote in a regular expression after a division',
      'ts',
      "const half = total / 2; const quote = /'/; const marker = '//'; fetch(marker);",
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in regular expressions after an if condition',
      'ts',
      'if (ready) /[/*]/.test(mark);\nfetch(mark);\n/[*/]/.test(mark);',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in regular expressions after a while condition holding a call',
      'ts',
      'while (pending(mark)) /[/*]/.test(mark);\nconst width = window.innerWidth;\n/[*/]/.test(mark);',
      DOMAIN_BANS,
      ['window'],
    ],
    [
      'block comment delimiters in regular expressions after a for head',
      'ts',
      'for (const mark of marks) /[/*]/.test(mark);\nlocalStorage.clear();\n/[*/]/.test(marks[0]);',
      DOMAIN_BANS,
      ['localStorage'],
    ],
    [
      'block comment delimiters in regular expressions after a for await head',
      'ts',
      'for await (const mark of marks) /[/*]/.test(mark);\nfetch(marks);\n/[*/]/.test(marks[0]);',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in regular expressions after the `of` of a for head',
      'ts',
      'for (const m of /[/*]/.exec(s) ?? []) use(m);\nfetch(s);\n/[*/]/.test(s);',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in regular expressions after the `of` of a for await head',
      'ts',
      'for await (const m of /[/*]/.exec(s) ?? []) use(m);\nconst width = window.innerWidth;\n/[*/]/.test(s);',
      DOMAIN_BANS,
      ['window'],
    ],
    [
      'block comment delimiters in regular expressions after a `!` opening a line',
      'ts',
      'const ready = value\n!/[/*]/.test(mark);\nfetch(mark);\n/[*/]/.test(mark);',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'block comment delimiters in default-exported and exported regular expressions',
      'ts',
      'export default /[/*]/;\nfetch(mark);\nexport const close = /[*/]/;',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'an apostrophe in JSX text',
      'tsx',
      "export const Hint = () => <p>Don't panic</p>; const marker = '//'; export const load = () => fetch(marker);",
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'a line comment delimiter in JSX text',
      'tsx',
      'export const Link = ({ url }: { url: string }) => <p>See //{fetch(url)}</p>;',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'a line comment delimiter in a JSX attribute',
      'tsx',
      'export const Mark = () => <abbr title="//">x</abbr>; export const load = () => fetch(\'/x\');',
      PRODUCTION_BANS,
      ['fetch('],
    ],
    [
      'a trailing backslash in a JSX attribute, which has no escapes',
      'tsx',
      'export const Path = () => <abbr title="C:\\" />; const marker = "//"; export const load = () => fetch(marker);',
      PRODUCTION_BANS,
      ['fetch('],
    ],
  ])('stripComments keeps the code after %s', (_case, syntax, source, bans, expected) => {
    const code = stripComments(source, syntax);
    expect(code).toBe(source);
    expect(bannedUses(code, bans)).toEqual(expected);
  });

  it.each<[SourceSyntax, string, RegExp]>([
    ['ts', "const a = 1;\nconst b = 'open", /^Unterminated string literal starting on line 2\.$/],
    ['ts', "const a = 'line\nbreak';", /Unterminated string literal/],
    ['ts', 'const a = `open', /Unterminated template literal starting/],
    ['ts', 'const a = `${open', /Unterminated template literal substitution/],
    ['ts', 'const a = /open', /Unterminated regular expression literal/],
    ['ts', 'const a = /line\nbreak/;', /Unterminated regular expression literal/],
    ['ts', '/* open', /Unterminated block comment/],
    ['ts', 'const a = 1; }', /Unbalanced \}/],
    ['tsx', 'const a = <p>open', /Unterminated JSX element/],
    ['tsx', 'const a = <p></p', /Unterminated JSX element/],
    ['tsx', 'const a = <p title="open />;', /Unterminated JSX attribute string/],
    ['tsx', 'const a = <p>{open', /Unterminated JSX expression/],
    ['tsx', 'const a = <List<string', /Unterminated JSX type argument list/],
    ['tsx', 'const a = <p>a < b</p>;', /Unexpected < in JSX text/],
    ['css', "a { content: 'open }", /Unterminated CSS string/],
    ['css', '/* open', /Unterminated CSS comment/],
    ['css', 'a { background: url(open }', /Unterminated CSS url\( token/],
  ])('stripComments as %s throws on %j rather than scan it out of step', (syntax, source, message) => {
    expect(() => stripComments(source, syntax)).toThrow(message);
  });

  // Every ECMAScript line terminator but LF, which the fixtures above use, plus CRLF, whose CR must end a line
  // comment without splitting the pair. Written as escapes, so this file holds none of them raw.
  const LINE_TERMINATORS: ReadonlyArray<[label: string, terminator: string]> = [
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ];

  // The .tsx source puts its line comment inside a JSX tag, which the scanner reads apart from other code.
  it.each(
    LINE_TERMINATORS.flatMap(([label, terminator]): Array<[SourceSyntax, string, string, string, string]> => [
      ['ts', label, terminator, 'export const probe = 1; ', "fetch('/x');"],
      ['tsx', label, terminator, 'export const Probe = () => <p ', "title={fetch('/x')}>x</p>;"],
    ]),
  )(
    'stripComments as %s ends a line comment at a %s and keeps the code after it',
    (syntax, _label, terminator, before, after) => {
      const code = stripComments(`${before}// comment${terminator}${after}`, syntax);
      expect(code).toBe(`${before}${terminator}${after}`);
      expect(bannedUses(code, PRODUCTION_BANS)).toEqual(['fetch(']);
    },
  );

  // DOMAIN_BANS stands in for the localStorage owner check here: both match the bare name.
  it.each<[string, string, readonly Ban[], string[]]>([
    ['CR', '// note\rconst jar = sessionStorage;', PRODUCTION_BANS, ['sessionStorage']],
    ['CRLF', '// note\r\nlocalStorage.clear();', DOMAIN_BANS, ['localStorage']],
    ['U+2028', '// note\u2028const jar = sessionStorage;', PRODUCTION_BANS, ['sessionStorage']],
    ['U+2029', '// note\u2029localStorage.clear();', DOMAIN_BANS, ['localStorage']],
  ])('a line comment ended by a %s hides no storage API from the bans', (_label, source, bans, expected) => {
    expect(bannedUses(stripComments(source, 'ts'), bans)).toEqual(expected);
  });

  it.each(LINE_TERMINATORS)(
    'a line comment ended by a %s hides no import from the layering check',
    (_label, terminator) => {
      const rule = IMPORT_RULES.find(({ layers }) => layers.includes('components'));
      if (rule === undefined) {
        throw new Error('IMPORT_RULES holds no rule for the components layer.');
      }
      const specifier = '../storage/localStore';
      const source = `// comment${terminator}import { STORAGE_KEY } from '${specifier}';`;
      expect(importSpecifiers(source, 'ts')).toEqual([specifier]);
      expect(importViolations('/src/components/Probe.tsx', source, rule)).toEqual([
        `'${specifier}' resolves to /src/storage/localStore, outside /src/domain/, /src/state/, /src/components/`,
      ]);
    },
  );

  it.each<[SourceSyntax, string, string]>([
    ['ts', 'U+2028', "const s = 'a\u2028b';"],
    ['ts', 'U+2029', 'const s = "a\u2029b";'],
    ['css', 'U+2028', "a::before { content: 'a\u2028b'; }"],
    ['css', 'U+2029', 'a::before { content: "a\u2029b"; }'],
  ])('stripComments as %s keeps a string holding a %s verbatim', (syntax, _label, source) => {
    expect(stripComments(source, syntax)).toBe(source);
  });

  it.each(LINE_TERMINATORS)(
    'stripComments throws on a regular expression literal a %s splits',
    (_label, terminator) => {
      expect(() => stripComments(`const a = /line${terminator}break/;`, 'ts')).toThrow(
        /Unterminated regular expression literal/,
      );
    },
  );

  // The `!` opening the second line is prefix, so the `/` after it opens a regular expression, and the `/*` in that
  // opens no comment. The line break before the `!` may stand alone or sit inside a block comment.
  it.each(
    LINE_TERMINATORS.flatMap(([label, terminator]): Array<[string, string, string, string]> => [
      [label, terminator, terminator, terminator],
      [`${label} in a block comment`, terminator, `/* gap${terminator}*/`, ' '],
    ]),
  )('a %s before a `!` opening a line hides no code behind a regular expression', (_label, terminator, gap, kept) => {
    const rest = ['!/[/*]/.test(mark);', 'fetch(mark);', '/[*/]/.test(mark);'].join(terminator);
    const code = stripComments(`const ready = value${gap}${rest}`, 'ts');
    expect(code).toBe(`const ready = value${kept}${rest}`);
    expect(bannedUses(code, PRODUCTION_BANS)).toEqual(['fetch(']);
  });

  it.each(LINE_TERMINATORS)(
    'stripComments counts a %s as one line break in the line an error names',
    (_label, terminator) => {
      expect(() => stripComments(`const a = 1;${terminator}const b = 'open`, 'ts')).toThrow(
        /^Unterminated string literal starting on line 2\.$/,
      );
    },
  );

  it.each<[string, string[]]>([
    [
      [".note::before { content: '/*'; }", "@import 'remote.css';", ".note::after { content: '*/'; }"].join('\n'),
      ['@import'],
    ],
    ['a::before { content: "\\"/*"; } @import \'remote.css\'; a::after { content: \'*/\'; }', ['@import']],
    [".it\\'s::before { content: '/*'; } @import 'remote.css'; .b::after { content: '*/'; }", ['@import']],
    [
      '.badge { background: url(//cdn.example/badge.png); } @font-face { font-family: Remote; }',
      ['@font-face', 'url(//cdn.example/badge.png)'],
    ],
  ])('stylesheetViolations finds what follows the comment delimiters in %j', (source, expected) => {
    expect(stripComments(source, 'css')).toBe(source);
    expect(stylesheetViolations(source)).toEqual(expected);
  });

  it.each<[string, string]>([
    ['<p><!-- fetch( --></p>', '<p> </p>'],
    ['<!--><script>fetch(1)</script><!-- window -->', ' <script>fetch(1)</script> '],
    ['<!---><p>x</p>', ' <p>x</p>'],
    ['<!-- fetch( --!><p>x</p>', ' <p>x</p>'],
  ])('stripHtmlComments removes the comments of %j where the HTML parser ends them', (html, expected) => {
    expect(stripHtmlComments(html)).toBe(expected);
  });

  it.each([
    '<meta content="<!--"><script>fetch(\'/x\')</script><meta content="-->">',
    "<meta content='<!--'><script>fetch('/x')</script><meta content='-->'>",
    "<script>const open = '<!--';</script><script>fetch('/x')</script><script>const close = '-->';</script>",
    "<title><!--</title><script>fetch('/x')</script><title>--></title>",
    '<!doctype html "<!--"><script>fetch(\'/x\')</script><p>--></p>',
  ])('stripHtmlComments keeps the script that %j puts between comment delimiters', (html) => {
    const code = stripHtmlComments(html);
    expect(code).toBe(html);
    expect(bannedUses(code, PRODUCTION_BANS)).toEqual(['fetch(']);
  });

  it('htmlReferences finds a script source between quoted comment delimiters', () => {
    const html = '<meta content="<!--"><script src="//cdn.example/remote.js"></script><meta content="-->">';
    expect(htmlReferences(stripHtmlComments(html))).toEqual(['//cdn.example/remote.js']);
  });

  it.each<[string, RegExp]>([
    ['<p><!-- open', /Unterminated HTML comment/],
    ['<meta content="open>', /Unterminated HTML attribute value/],
    ['<meta charset="UTF-8"', /Unterminated HTML tag/],
  ])('stripHtmlComments throws on %j rather than scan it out of step', (html, message) => {
    expect(() => stripHtmlComments(html)).toThrow(message);
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
    expect(importSpecifiers(source, 'ts').sort()).toEqual(['../b', './a', './c', './d.css', 'react-dom/client']);
  });

  it.each<[SourceSyntax, string]>([
    [
      'ts',
      ["const open = '/*';", "import { STORAGE_KEY } from '../storage/localStore';", "const close = '*/';"].join('\n'),
    ],
    [
      'ts',
      ['const open = `/*`;', "export { STORAGE_KEY } from '../storage/localStore';", 'const close = `*/`;'].join('\n'),
    ],
    [
      'tsx',
      [
        "export const Hint = () => <p>Don't</p>; const open = '/*';",
        "import { STORAGE_KEY } from '../storage/localStore';",
        "const close = '*/';",
      ].join('\n'),
    ],
    [
      'ts',
      [
        'if (ready) /[/*]/.test(mark);',
        "import { STORAGE_KEY } from '../storage/localStore';",
        '/[*/]/.test(mark);',
      ].join('\n'),
    ],
  ])('importSpecifiers finds the import between comment delimiters in %s source %j', (syntax, source) => {
    expect(stripComments(source, syntax)).toBe(source);
    expect(importSpecifiers(source, syntax)).toEqual(['../storage/localStore']);
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
  it.each(filesInLayers(['components', 'app']))('%s does not reference applyCommand or findRule', (file, source) => {
    expect(stripComments(source, syntaxOf(file)).match(/\b(?:applyCommand|findRule)\b/g) ?? []).toEqual([]);
  });
});

describe('hash routing lives only in useHashRoute.ts', () => {
  it('useHashRoute.ts is a production module', () => {
    expect(productionPaths).toContain(HASH_ROUTE_MODULE);
  });

  it.each(productionEntries.filter(([path]) => path !== HASH_ROUTE_MODULE))(
    '%s does not reference hashchange or location.hash',
    (file, source) => {
      expect(stripComments(source, syntaxOf(file)).match(/\bhashchange\b|\blocation\.hash\b/g) ?? []).toEqual([]);
    },
  );
});

describe('the domain uses no browser API and reads no clock', () => {
  it.each(filesInLayers(['domain']))('%s', (file, source) => {
    expect(bannedUses(stripComments(source, syntaxOf(file)), DOMAIN_BANS)).toEqual([]);
  });
});

// Each file is stripped inside its own test, so a file the scanner cannot follow fails under its own name.
describe('no network API, other storage API, HTML injection or dynamic import', () => {
  it.each(productionEntries)('%s', (file, source) => {
    expect(bannedUses(stripComments(source, syntaxOf(file)), PRODUCTION_BANS)).toEqual([]);
  });

  it('/index.html', () => {
    expect(bannedUses(stripHtmlComments(indexHtml), PRODUCTION_BANS)).toEqual([]);
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
    (file, source) => {
      expect(stripComments(source, syntaxOf(file)).match(/\blocalStorage\b/g) ?? []).toEqual([]);
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
    expect(stylesheetViolations(source)).toEqual([]);
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
