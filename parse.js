// A fast, dependency-free Markdown renderer whose output matches marked 18.1.3
// with its default options (GFM on, breaks off, pedantic off, async off), for
// every input string. Written from scratch in this session.
//
// Architecture, in my own layout:
//   1. a small regex-composition helper, then every pattern the grammar needs,
//      built once at module load (nothing is compiled per parse() call);
//   2. a block lexer that turns the source into a flat token list, queueing
//      inline sources so link definitions found later in the document still
//      apply to earlier paragraphs (as marked does);
//   3. an inline lexer that turns each queued source into inline tokens,
//      with the delimiter-masking trick that keeps emphasis closers inside
//      links, code spans and raw HTML from being seen as closers;
//   4. a renderer that walks the tokens and builds the HTML string.
//
// Nothing is kept between parse() calls: every call builds its own lexer
// state and returns a string computed from the argument alone.

'use strict';

// ---------------------------------------------------------------------------
// Regex composition
// ---------------------------------------------------------------------------
// A tiny builder: start from a pattern (string or RegExp), then splice other
// patterns in by name. A `^` at the start of a spliced fragment (or right
// after a character that is not `[`) is dropped, because the fragment is
// being embedded in the middle of a larger pattern where the anchor would
// be meaningless. The finished pattern is compiled with the given flags.
const CARET = /(^|[^\[])\^/g;
function rx(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  return {
    sub(pat, rep) {
      let r = typeof rep === 'string' ? rep : rep.source;
      r = r.replace(CARET, '$1');
      s = s.replace(pat, r);
      return this;
    },
    re() { return new RegExp(s, flags); },
  };
}

// Cache of small regexes that depend on an indent number (0..3). The same
// indent is asked for over and over, so each is compiled at most once.
function cached(make) {
  const box = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    let r = box[i];
    if (!r) r = box[i] = make(i);
    return r;
  };
}

// ---------------------------------------------------------------------------
// Shared small patterns
// ---------------------------------------------------------------------------
const R = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (() => {
    const seen = new Map();
    return (bullet) => {
      let r = seen.get(bullet);
      if (!r) {
        r = new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
        seen.set(bullet, r);
      }
      return r;
    };
  })(),
  nextBulletRegex: cached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cached((n) => new RegExp(`^ {0,${n}}>`)),
};

// The list of block-level HTML tag names (used by the HTML-block rules).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block patterns (GFM set)
// ---------------------------------------------------------------------------
const BLANK = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// A setext underline, with the first line kept away from anything that would
// start a different block (a list, a fence, a quote, a heading, an hr, an
// HTML block or a table).
const SETTEXT_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const SETEXT = rx(SETTEXT_SRC)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/\|table/g, '')
  .re();
const SETEXT_GFM = rx(SETTEXT_SRC)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .re();
// A paragraph: lines that do not start another block.
const PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paraWith(listPat) {
  return rx(PARA_SRC)
    .sub('hr', HR)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '')
    .sub('|table', '')
    .sub('blockquote', ' {0,3}>')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', listPat)
    .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .sub('tag', BLOCK_TAGS)
    .re();
}
const PARA_NORMAL = paraWith(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const PARA_QUOTE = paraWith(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
// A GFM table: header line, delimiter line, then body rows.
const TABLE_RE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .sub('hr', HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', BLOCK_TAGS)
  .re();
const PARA_GFM = rx(PARA_SRC)
  .sub('hr', HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('table', TABLE_RE)
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', BLOCK_TAGS)
  .re();
// A block quote: `>` lines, plus lazy paragraph continuation lines.
const BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', PARA_QUOTE).re();
// A link reference definition: `[label]: destination "title"`.
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', LABEL)
  .sub('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .re();
// A list item's first line.
const LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET).re();
const TEXT_LINE = /^[^\n]+/;
// An HTML comment.
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
// An HTML block.
const HTML_BLOCK = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .sub('comment', COMMENT)
  .sub('tag', BLOCK_TAGS)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .re();

const BLOCK = {
  newline: BLANK,
  code: INDENTED_CODE,
  fences: FENCES,
  heading: ATX,
  hr: HR,
  blockquote: BLOCKQUOTE,
  list: LIST,
  html: HTML_BLOCK,
  def: DEF,
  table: TABLE_RE,
  lheading: SETEXT_GFM,
  paragraph: PARA_GFM,
  text: TEXT_LINE,
};

// ---------------------------------------------------------------------------
// Inline patterns (GFM set)
// ---------------------------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;                 // any punctuation or symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;         // punctuation, symbol or space
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;    // a word character, roughly
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;  // punctuation, but not a tilde
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
// A hard break: two or more spaces, or a backslash, before a line end.
const HARD_BREAK = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// Plain text: runs until something that could start another inline token.
const TEXT_NORMAL = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_WITH_SCHEME = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_LOCAL).re();
const TEXT_GFM = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', SCHEME)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .re();
// An autolink `<scheme:...>` or `<someone@example.com>`.
const AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .re();
// Raw HTML tag, processing instruction, declaration or CDATA section.
const TAG = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .sub('comment', rx(COMMENT).sub('(?:-->|$)', '-->').re())
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .re();
// A link label: balanced brackets, backslash escapes, code spans.
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).sub('brackets', BRACKETS).re();
const LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_INNER)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .re();
const REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_INNER).sub('ref', LABEL).re();
const NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LABEL).re();
// The long label forms used only while masking (see the masking section).
const LABEL_LONG = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).sub('brackets', BRACKETS).re();
const REF_ANY = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .sub('reflink', rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_LONG).sub('ref', REF_ANY).re())
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', REF_ANY).re())
  .re();
// GFM extended autolinks: www., scheme:// and bare email addresses.
const URL_GFM = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', EMAIL_WITH_SCHEME)
  .sub('protocol', SCHEME)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .re();
// How far back a GFM URL may be trimmed: trailing punctuation and balanced
// parentheses are peeled off, one piece at a time.
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
// Strikethrough: `~~text~~` (and the single-tilde form, which the left
// delimiter below also accepts).
const DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const DEL_LEFT = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).re();
const DEL_RIGHT_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const DEL_RIGHT = rx(DEL_RIGHT_SRC, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .re();
// Emphasis / strong left delimiters: a run of `*` or `_`, plus what follows.
const EM_LEFT_SRC = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_LEFT = rx(EM_LEFT_SRC, 'u').sub(/punct/g, PUNCT_NOT_TILDE).re();
// Emphasis / strong right delimiters: the scanner that walks a candidate
// closer run and reports, per match, which delimiter run (if any) it found
// and what surrounds it. The GFM variant treats `~` as a word character.
const EM_RIGHT_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_RIGHT_AST = rx(EM_RIGHT_AST_SRC, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .sub(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
  .sub(/punct/g, PUNCT_NOT_TILDE)
  .re();
const EM_RIGHT_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const EM_RIGHT_UND = rx(EM_RIGHT_UND_SRC, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .re();
// A single character that can follow a backslash inside a link label, etc.
const PUNCTUATION = rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).re();
// Anything that looks like a link, a code span or raw HTML, used to mask
// those spans out of the text emphasis closers are searched in.
const BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\()\\]|\((?:\\[\s\S]|[^\()\\])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .re();
// A backslash followed by any punctuation, and the same outside code spans.
const ANY_PUNCT = rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).re();
const ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).re();

const INLINE = {
  escape: ESCAPE,
  code: CODE_SPAN,
  br: HARD_BREAK,
  text: TEXT_GFM,
  autolink: AUTOLINK,
  tag: TAG,
  link: LINK,
  reflink: REFLINK,
  nolink: NOLINK,
  reflinkSearch: REFLINK_SEARCH,
  url: URL_GFM,
  backpedal: URL_BACKPEDAL,
  del: DEL,
  delLDelim: DEL_LEFT,
  delRDelim: DEL_RIGHT,
  emStrongLDelim: EM_LEFT,
  emStrongRDelimAst: EM_RIGHT_AST,
  emStrongRDelimUnd: EM_RIGHT_UND,
  punctuation: PUNCTUATION,
  blockSkip: BLOCK_SKIP,
  anyPunctuation: ANY_PUNCT,
  anyPunctuationOutsideCode: ANY_PUNCT_OUTSIDE_CODE,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape HTML characters. With `encode` true, `&` is always escaped; without
// it, an `&` that already starts a valid entity or character reference is
// left alone (that is how text content is escaped, versus code content).
function escHtml(s, encode) {
  if (encode) {
    if (R.escapeTest.test(s)) return s.replace(R.escapeReplace, (c) => ESCAPE_MAP[c]);
  } else if (R.escapeTestNoEncode.test(s)) {
    return s.replace(R.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c]);
  }
  return s;
}
// Turn `&#169;`, `&#xA9;` and friends into the character they name; a bare
// `&` that is not a valid reference becomes `&amp;`.
function unescapeEntities(s) {
  if (!R.numericCharacterReference.test(s)) return s;
  return s.replace(R.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}
// Percent-encode a link destination the way a browser would, keeping `%`
// that already starts an escape (marked decodes `%25` back to `%`).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}
// A link label, normalised for lookup: collapse whitespace, fold case the
// Unicode way (lower, then upper, then lower again, as marked does).
function normalizeLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Strip trailing characters `ch` from a string, unless `keep` says to strip
// every character that is NOT `ch` instead (used for closing hashes).
function stripTrailing(s, ch, keep) {
  const n = s.length;
  if (n === 0) return '';
  let i = 0;
  for (;;) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !keep) i++;
    else if (c !== ch && keep) i++;
    else break;
  }
  return s.slice(0, n - i);
}
// Drop trailing blank lines from a block of code, keeping at most one blank
// line at the end (the indented-code rule).
function trimTrailingBlanks(src) {
  const lines = src.split('\n');
  let end = lines.length - 1;
  for (; end >= 0 && R.blankLine.test(lines[end]);) end--;
  return lines.length - end <= 2 ? src : lines.slice(0, end + 1).join('\n');
}
// Expand tabs to spaces, counting columns from `startCol`.
function expandTabs(s, startCol) {
  let col = startCol;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}
// In `s`, find the index of the first `)` that has no matching `(` before
// it (backslashes skip the next character). Returns -1 when every `)` is
// matched, -2 when a `(` is left unmatched.
function findUnpairedParen(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}
// Split a table row on unescaped pipes, honouring the header column count.
function splitTableRow(s, cols) {
  const withSpaces = s.replace(R.findPipe, (ch, off, whole) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && whole[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withSpaces.split(R.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (cols) {
    if (cells.length > cols) cells.splice(cols);
    else for (; cells.length < cols;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Emphasis masking
// ---------------------------------------------------------------------------
// Before looking for emphasis closers, marked hides the parts of a line
// that cannot contain one: link and reference-link spans become runs of
// `a`, code spans become `+`s, raw HTML becomes... nothing (it is left, but
// its `<`s are what matter). The masked copy has exactly the same length
// as the original, so every index found in it is valid in the original too.
//
// `scanClosers` walks such a masked string and records, for each delimiter
// kind, the index of the last run that could close an emphasis span (a run
// not preceded by a space, tab, newline, carriage return or form feed, for
// `*`/`_`; any `~` run for `~`). The inline lexer caches one scan per
// (tokenizer, source) pair because the same source is scanned once per
// opener it contains.
const maskCache = new WeakMap();
function scanClosers(src) {
  const last = { '*': -1, _: -1 };
  let lastTilde = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastTilde };
}
// Is there a `*`, `_` or `~` inside a bracket span? The reflink pass
// only changes the closer scan when a link label holds such a delimiter,
// so paragraphs without one can skip the pass entirely. A backslash
// anywhere disables the shortcut (an escaped bracket would throw the
// depth count off), and the pass then runs as before.
const BRACKET_DELIM_RE = /[\[\]*_~]/g;
function hasDelimInBrackets(src) {
  BRACKET_DELIM_RE.lastIndex = 0;
  let depth = 0, m;
  while ((m = BRACKET_DELIM_RE.exec(src)) !== null) {
    const ch = m[0];
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth > 0) depth--; }
    else if (depth > 0) return true;
  }
  return false;
}
function maskSource(lexer, src) {
  // Reference links whose label is defined are masked as `a`s (their text
  // cannot hold a closer); undefined ones are left alone.
  let masked = src;
  if (lexer.hasLinks && src.includes('[') && src.includes(']')
    && (src.includes('\\') || hasDelimInBrackets(src))) {
    const search = INLINE.reflinkSearch;
    const maskOne = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(lexer.links, normalizeLabel(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (lexer.linkInText(inner)) {
          return '[' + inner.replace(search, maskOne) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  // Backslash-escaped punctuation becomes `+`s; inside a code span only
  // stray backticks become `+`s, the fence backticks stay. Neither can
  // occur without a backslash or a backtick in the source.
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) =>
      punct ? '+'.repeat(whole.length)
      : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
      : whole);
  }
  // Links become fake `[aaa]` spans and code spans keep their opening
  // ticks; both keep their exact length. Nothing to hide without one of
  // `[`, backtick or `<` in the source.
  if (masked.includes('](') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(INLINE.blockSkip, (whole, _labelTicks, codeTicks) => {
      const lead = codeTicks ? codeTicks.length : 0;
      return whole.slice(0, lead) + '[' + 'a'.repeat(whole.length - lead - 2) + ']';
    });
  }
  return masked;
}
function rememberMask(tok, masked) {
  const scan = scanClosers(masked);
  let list = maskCache.get(tok);
  if (list) list.push({ masked, scan });
  else maskCache.set(tok, [{ masked, scan }]);
}
function forgetMask(tok) {
  const list = maskCache.get(tok);
  if (list) {
    list.pop();
    if (list.length === 0) maskCache.delete(tok);
  }
}
function lastEmCloser(tok, src, kind) {
  const list = maskCache.get(tok);
  const top = list && list[list.length - 1];
  if (top && top.masked === src) return top.scan.last[kind];
  return scanClosers(src).last[kind];
}
function lastDelCloser(tok, src) {
  const list = maskCache.get(tok);
  const top = list && list[list.length - 1];
  if (top && top.masked === src) return top.scan.lastTilde;
  return scanClosers(src).lastTilde;
}


// Index of the first character that is not a space, or -1 when there is none.
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}
// A line holding only spaces and tabs (or nothing).
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}
// Leading spaces of a line, capped at `lim` (the block-start tests allow
// at most `lim` spaces before their marker).
function leadSpaces(s, lim) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < lim) i++;
  return i;
}
// Does the line start (after at most `lim` spaces) a fenced code block?
function isFenceBegin(s, lim) {
  const i = leadSpaces(s, lim);
  if (i >= s.length || s[i] !== ' ' && i > lim) return false;
  if (i < s.length && s[i] === ' ') return false;
  const rest = s.slice(i);
  return rest.startsWith('```') || rest.startsWith('~~~');
}
// Does the line start an ATX heading?
function isHeadingBegin(s, lim) {
  let i = leadSpaces(s, lim);
  if (i < s.length && s[i] === ' ') return false;
  let h = 0;
  while (h < 6 && s[i + h] === '#') h++;
  if (h === 0) return false;
  const nx = s[i + h];
  return nx === undefined || nx === ' ' || nx === '\t' || nx === '\n' || nx === '\r' || nx === '\f' || nx === '\v';
}
// Does the line start a block quote?
function isBlockquoteBegin(s, lim) {
  const i = leadSpaces(s, lim);
  return !(i < s.length && s[i] === ' ') && s[i] === '>';
}
// Does the line start a new list item (any bullet)?
function isNextBullet(s, lim) {
  let i = leadSpaces(s, lim);
  if (i < s.length && s[i] === ' ') return false;
  const c = s[i];
  if (c === '-' || c === '+' || c === '*') {
    const nx = s[i + 1];
    return nx === undefined || nx === ' ' || nx === '\t';
  }
  if (c >= '0' && c <= '9') {
    let j = i;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j - i > 9) return false;
    if (s[j] !== '.' && s[j] !== ')') return false;
    const nx = s[j + 1];
    return nx === undefined || nx === ' ' || nx === '\t';
  }
  return false;
}
// Is the line a thematic break (after at most `lim` spaces)?
function isHrLine(s, lim) {
  let i = leadSpaces(s, lim);
  if (i < s.length && s[i] === ' ') return false;
  const c = s[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let n = 0;
  for (; i < s.length; i++) {
    if (s[i] === c) n++;
    else if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return n >= 3;
}
// Is the line a setext underline (`===` or `---`, trailing spaces only)?
function isSetextUnderline(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i < s.length && s[i] === ' ') return false;
  const c = s[i];
  if (c !== '=' && c !== '-') return false;
  for (; i < s.length; i++) if (s[i] !== c && s[i] !== ' ') return false;
  return true;
}


// Does the line start another block? The block-start tests each allow
// only a few leading spaces and each needs a specific first character, so
// one scan of the leading spaces plus a dispatch on that character
// replaces six separate tests. `indent` is the space allowance of the
// HTML test, `lim` that of the others; `bulletToo` adds the blockquote
// and list-item tests (the item-continuation loop needs them, the
// content check does not).
function isBlockStartLine(s, lim, indent, bulletToo) {
  let sp = 0;
  while (sp < s.length && s[sp] === ' ') sp++;
  if (sp > indent) return false;
  const c = s[sp];
  if (c === '<') return R.htmlBeginRegex(indent).test(s);
  if (sp > lim) return false;
  if (c === '`' || c === '~') return isFenceBegin(s, lim);
  if (c === '#') return isHeadingBegin(s, lim);
  if (c === '>') return bulletToo && isBlockquoteBegin(s, lim);
  if (c === '-' || c === '_' || c === '*') return isHrLine(s, lim)
    || (bulletToo && (c !== '_' && isNextBullet(s, lim)));
  if (bulletToo && (c === '+' || (c >= '0' && c <= '9'))) return isNextBullet(s, lim);
  return false;
}

// Is there a setext underline line below the first line of `src`, before
// any line that cannot be part of a setext heading's content (a blank line
// or a line that starts another block)? The content of a setext heading
// cannot cross such a line, so the search stops there.
function hasSetextUnderline(src) {
  let p = src.indexOf('\n');
  while (p !== -1) {
    const e = src.indexOf('\n', p + 1);
    const line = e === -1 ? src.slice(p + 1) : src.slice(p + 1, e);
    if (isSetextUnderline(line)) return true;
    if (isSetextBlocker(line)) return false;
    p = e;
  }
  return false;
}
// A line that cannot be part of a setext heading's content: a blank line,
// or a line that starts a list, a fence, a quote, a heading, a thematic
// break, an HTML block, or a table delimiter.
function isSetextBlocker(line) {
  if (isBlankLine(line)) return true;
  let sp = 0;
  while (sp < 3 && line[sp] === ' ') sp++;
  if (sp < line.length && line[sp] === ' ') return false;
  const c = line[sp];
  if (c === '>') return true;
  if (c === '#') return isHeadingBegin(line, 3);
  if (c === '`' || c === '~') return isFenceBegin(line, 3);
  if (c === '-' || c === '+' || c === '*') {
    // A bullet only blocks when followed by a space (the lookahead's
    // bullet pattern is followed by one); otherwise the line may still
    // be a thematic break, checked below.
    if (line[sp + 1] === ' ') return true;
  }
  if (c >= '0' && c <= '9') {
    let j = sp;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - sp <= 9 && (line[j] === '.' || line[j] === ')') && line[j + 1] === ' ') return true;
  }
  if (isHrLine(line, 3)) return true;
  if (c === '<') {
    // `<...>` to the end of the line.
    const gt = line.indexOf('>');
    if (gt !== -1 && gt === line.length - 1) return true;
  }
  // A table delimiter line: only `|`, `:`, `-` and spaces, with a `|`.
  if (c === '|' || c === ':' || c === '-') {
    let pipe = false;
    for (let j = sp; j < line.length; j++) {
      const ch = line[j];
      if (ch === '|') pipe = true;
      else if (ch !== ':' && ch !== '-' && ch !== ' ') return false;
    }
    if (pipe) return true;
  }
  return false;
}
// Is the second line of `src` a table delimiter line (only `|`, `:`, `-`,
// spaces and tabs, with at least one `-`, after up to 3 leading spaces)?
function hasTableDelimiter(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  // The header line must hold a non-space character.
  let hasContent = false;
  for (let i = 0; i < nl; i++) if (src[i] !== ' ' && src[i] !== '\t') { hasContent = true; break; }
  if (!hasContent) return false;
  let i = nl + 1;
  let sp = 0;
  while (sp < 3 && src[i + sp] === ' ') sp++;
  i += sp;
  let dash = false;
  let j = i;
  for (;; j++) {
    const c = src[j];
    if (c === '-') dash = true;
    else if (c === '|' || c === ':' || c === ' ' || c === '\t') { /* ok */ }
    else break;
  }
  return dash && (src[j] === '\n' || j === src.length);
}

// ---------------------------------------------------------------------------
// Block tokenizer: one method per block kind, each returning a token or
// undefined. `lexer` is the owning Lexer, set before use.
// ---------------------------------------------------------------------------
class Tok {
  constructor() {
    this.lexer = null;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return;
    const raw = trimTrailingBlanks(m[0]);
    const text = raw.replace(R.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return;
    const raw = m[0];
    let text = m[3] || '';
    // A fence whose info string is indented can pull the body with it:
    // compensate lines that are indented less than the info line was.
    const comp = raw.match(R.indentCodeCompensation);
    if (comp !== null) {
      const pad = comp[1];
      text = text.split('\n').map((line) => {
        const lead = line.match(R.beginningSpace);
        if (lead === null) return line;
        return line.slice(Math.min(lead[0].length, pad.length));
      }).join('\n');
    }
    const info = m[2];
    return {
      type: 'code',
      raw,
      lang: info ? info.trim().replace(INLINE.anyPunctuation, '$1') : info,
      text,
    };
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return;
    let text = m[2].trim();
    if (R.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTrailing(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    let lines = stripTrailing(m[0], '\n').split('\n');
    let rawOut = '';
    let textOut = '';
    const toks = [];
    for (; lines.length > 0;) {
      let chunk = [];
      let p;
      let found = false;
      for (p = 0; p < lines.length; p++) {
        if (R.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); found = true; }
        else if (!found) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const joined = chunk.join('\n');
      const stripped = joined
        .replace(R.blockquoteMarkerWhitespace, (g, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      rawOut = rawOut ? rawOut + '\n' + joined : joined;
      textOut = textOut ? textOut + '\n' + stripped : stripped;
      const wasTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, toks, true);
      this.lexer.state.top = wasTop;
      if (lines.length === 0) break;
      const last = toks[toks.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const rest = lines.join('\n');
        const again = last.raw + '\n' + rest.replace(R.blockquoteSetextReplace2, '');
        const inner = this.blockquote(again);
        toks[toks.length - 1] = inner;
        const leftover = again.substring(inner.raw.length).replace(/^\n/, '');
        const nLeft = leftover ? leftover.split('\n').length : 0;
        const taken = nLeft ? lines.slice(0, -nLeft) : lines;
        if (taken.length > 0) rawOut = rawOut + '\n' + taken.join('\n');
        textOut = textOut.substring(0, textOut.length - last.text.length) + inner.text;
        lines = lines.slice(taken.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        const whole = last.raw + '\n' + lines.join('\n');
        const relisted = this.list(whole);
        toks[toks.length - 1] = relisted;
        const extra = relisted.raw.length > last.raw.length
          ? whole.slice(last.raw.length + 1, relisted.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          rawOut = rawOut + '\n' + taken;
          textOut = textOut + '\n' + taken;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw: rawOut, tokens: toks, text: textOut };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const listTok = {
      type: 'list', raw: '', ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false, items: [],
    };
    const delim = ordered ? bullet.slice(-1) : '';
    let pos = 0;
    let sawDoubleBlank = false;
    for (;;) {
      // --- one item, starting at pos ---
      const itemStart = pos;
      const lineEnd = src.indexOf('\n', pos);
      const line = lineEnd === -1 ? src.slice(pos) : src.slice(pos, lineEnd);
      // Marker: up to 3 spaces, the bullet, then space, tab or end of line.
      let sp = 0;
      while (sp < line.length && line[sp] === ' ') sp++;
      if (sp > 3) break;
      let bulletLen;
      if (ordered) {
        let d = sp;
        while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
        if (d === sp || d - sp > 9 || line[d] !== delim) break;
        bulletLen = d - sp + 1;
      } else {
        if (line[sp] !== bullet) break;
        bulletLen = 1;
      }
      const after = line[sp + bulletLen];
      if (after !== undefined && after !== ' ' && after !== '\t') break;
      // A thematic break is not a list item.
      if (isHrLine(line, 3)) break;
      const markerLen = sp + bulletLen;
      pos = lineEnd === -1 ? src.length : lineEnd + 1;
      let firstLine = line.slice(markerLen);
      // Expand leading tabs of the first line, counting from the marker.
      if (firstLine[0] === ' ' || firstLine[0] === '\t') {
        let w = 0;
        while (w < firstLine.length && (firstLine[w] === ' ' || firstLine[w] === '\t')) w++;
        firstLine = expandTabs(firstLine.slice(0, w), markerLen) + firstLine.slice(w);
      }
      const content0 = firstLine;
      const firstEmpty = !content0.trim();
      let indent;
      let itemText;
      if (firstEmpty) {
        indent = markerLen + 1;
        itemText = '';
      } else {
        indent = firstNonSpace(content0);
        if (indent > 4) indent = 1;
        itemText = content0.slice(indent);
        indent += markerLen;
      }
      // The line after the marker line.
      const nextEnd = src.indexOf('\n', pos);
      const nextLine = nextEnd === -1 ? src.slice(pos) : src.slice(pos, nextEnd);
      let emptyItem = false;
      if (firstEmpty && isBlankLine(nextLine)) {
        pos = nextEnd === -1 ? src.length : nextEnd + 1;
        emptyItem = true;
      }
      let content = content0;
      if (!emptyItem) {
        // The block-start tests allow at most clamp(indent-1, 0, 3) spaces.
        const lim = Math.max(0, Math.min(3, indent - 1));
        let prevEmpty = firstEmpty;
        for (; pos < src.length;) {
          const le = src.indexOf('\n', pos);
          const ln = le === -1 ? src.slice(pos) : src.slice(pos, le);
          if (isBlockStartLine(ln, lim, indent, true)) break;
          let expanded = ln;
          if (ln[0] === ' ' || ln[0] === '\t') {
            let w = 0;
            while (w < ln.length && (ln[w] === ' ' || ln[w] === '\t')) w++;
            expanded = expandTabs(ln.slice(0, w), 0) + ln.slice(w);
          }
          const fns = firstNonSpace(expanded);
          if (fns >= indent || fns === -1) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            const c2 = content.includes('\t') ? content.replace(/\t/g, '    ') : content;
            if (prevEmpty || firstNonSpace(c2) >= 4 || isBlockStartLine(content, lim, indent, false)) break;
            let setextLine = ln;
            if (isSetextUnderline(ln) && BLOCK.lheading.test(`${content}\n${ln}`)) {
              let s = 0;
              while (s < 3 && expanded[s] === ' ') s++;
              setextLine = '    ' + expanded.slice(s);
            }
            itemText += '\n' + setextLine;
          }
          prevEmpty = fns === -1;
          content = expanded.slice(indent);
          pos = le === -1 ? src.length : le + 1;
        }
      }
      const rawItem = src.slice(itemStart, pos);
      if (!listTok.loose) {
        if (sawDoubleBlank) listTok.loose = true;
        else if (R.doubleBlankLine.test(rawItem)) sawDoubleBlank = true;
      }
      listTok.items.push({
        type: 'list_item', raw: rawItem,
        task: !!R.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
      if (pos >= src.length) break;
    }
    const lastItem = listTok.items[listTok.items.length - 1];
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = src.slice(0, pos).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => R.anyLine.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        first.raw = first.raw.replace(R.listReplaceTask, '');
        first.text = first.text.replace(R.listReplaceTask, '');
        for (let q = this.lexer.inlineQueue.length - 1; q >= 0; q--) {
          if (R.listIsTask.test(this.lexer.inlineQueue[q].src)) {
            this.lexer.inlineQueue[q].src = this.lexer.inlineQueue[q].src.replace(R.listReplaceTask, '');
            break;
          }
        }
        const box = R.listTaskCheckbox.exec(item.raw);
        if (box) {
          const check = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = check.checked;
          if (listTok.loose) {
            if (first && (first.type === 'paragraph' || first.type === 'text') && 'tokens' in first && first.tokens) {
              first.raw = check.raw + first.raw;
              first.text = check.raw + first.text;
              first.tokens.unshift(check);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
            }
          } else {
            item.tokens.unshift(check);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }
  html(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return;
    const raw = trimTrailingBlanks(m[0]);
    return {
      type: 'html', block: true, raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return;
    if (!R.startAngleBracket.test(m[2]) && findUnpairedParen(m[2]) !== -1) return;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
  }

  table(src) {
    if (!hasTableDelimiter(src)) return;
    const m = BLOCK.table.exec(src);
    if (!m || !R.tableDelimiter.test(m[2])) return;
    const headerCells = splitTableRow(m[1]);
    const alignParts = m[2].replace(R.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(R.tableRowBlankLine, '').split('\n') : [];
    const tableTok = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== alignParts.length) return;
    for (const part of alignParts) {
      if (R.tableAlignRight.test(part)) tableTok.align.push('right');
      else if (R.tableAlignCenter.test(part)) tableTok.align.push('center');
      else if (R.tableAlignLeft.test(part)) tableTok.align.push('left');
      else tableTok.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      tableTok.header.push({
        text: headerCells[i], tokens: this.lexer.inline(headerCells[i]),
        header: true, align: tableTok.align[i],
      });
    }
    for (const line of bodyLines) {
      tableTok.rows.push(splitTableRow(line, tableTok.header.length).map((cell, i) => ({
        text: cell, tokens: this.lexer.inline(cell), header: false, align: tableTok.align[i],
      })));
    }
    return tableTok;
  }

  lheading(src) {
    // Cheap guard: a setext heading needs an underline line (`===` or
    // `---`) somewhere below the first line; without one the pattern
    // cannot match, and scanning for it by hand is far cheaper than
    // running the setext pattern over the whole remainder.
    if (!hasSetextUnderline(src)) return;
    const m = BLOCK.lheading.exec(src);
    if (!m) return;
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------
// Does `label` (the text of a link label, starting at `offset` characters
// into `src`) contain a raw HTML tag or autolink that reaches past the end
// of the label? If so the label cannot be a link: the tag would swallow
// the closing bracket.
function hasRawTagOrCode(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = INLINE.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}
// Build a link (or image) token from a matched label: tokenize the label
// text, and refuse the link when a nested link was emitted inside it
// (nested links are not allowed; images may contain them).
function makeLink(match, dest, raw, lexer) {
  const text = match[1].replace(R.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nested = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (nested) {
      lexer.state.inRawBlock = prevRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw, href: dest.href, title: dest.title || null, text, tokens,
  };
}

// ---------------------------------------------------------------------------
// Inline tokenizer (extends the block tokenizer; one object does both)
// ---------------------------------------------------------------------------
class FullTok extends Tok {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return;
    const lexer = this.lexer;
    if (!lexer.state.inLink && R.startATag.test(m[0])) lexer.state.inLink = true;
    else if (lexer.state.inLink && R.endATag.test(m[0])) lexer.state.inLink = false;
    if (!lexer.state.inRawBlock && R.startPreScriptTag.test(m[0])) lexer.state.inRawBlock = true;
    else if (lexer.state.inRawBlock && R.endPreScriptTag.test(m[0])) lexer.state.inRawBlock = false;
    return {
      type: 'html', raw: m[0],
      inLink: lexer.state.inLink, inRawBlock: lexer.state.inRawBlock,
      block: false, text: m[0],
    };
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (!m) return;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasRawTagOrCode(src, m[1], bang)) return;
    const href = m[2].trim();
    if (R.startAngleBracket.test(href)) {
      if (!R.endAngleBracket.test(href)) return;
      const unslashed = stripTrailing(href.slice(0, -1), '\\');
      if ((href.length - unslashed.length) % 2 === 0) return;
    } else {
      const unp = findUnpairedParen(m[2]);
      if (unp === -2) return;
      if (unp > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + unp;
        m[2] = m[2].substring(0, unp);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const unslashed = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - unslashed.length) % 2 === 0) return;
    let dest = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    dest = dest.trim();
    if (R.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return makeLink(m, {
      href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1'),
    }, m[0], this.lexer);
  }

  reflink(src, links) {
    let m;
    if ((m = INLINE.reflink.exec(src)) || (m = INLINE.nolink.exec(src))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (hasRawTagOrCode(src, m[1], bang)) return;
      const ref = links[normalizeLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return makeLink(m, ref, m[0], this.lexer);
    }
  }

  emStrong(src, masked, prevChar = '') {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const startPos = masked.length - src.length;
    let runStart = startPos;
    for (; runStart > 0 && masked[runStart - 1] === delim;) runStart--;
    const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    let prev = prevChar;
    if (runStart < startPos) prev = beforeRun;
    const prevIsPunct = runStart < startPos ? beforeIsPunct : !!INLINE.punctuation.exec(prev);
    if (m[4] && prev.match(R.unicodeAlphaNumeric)) return;
    const after = m[1] || m[3] || '';
    if (!after || !prev || prevIsPunct) {
      const lastUnit = m[0].charCodeAt(m[0].length - 1);
      const runLen = m[0].length - (lastUnit >= 0xDC00 && lastUnit <= 0xDFFF ? 2 : 1);
      let g, b;
      let need = runLen;
      let spare = 0;
      const totalRun = startPos - runStart + runLen;
      const canAlsoClose = !!beforeRun.trim() && (!!after || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const scanRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastEmCloser(this, masked, delim);
      const afterOpener = masked.length - src.length + runLen;
      if (lastCloser < afterOpener) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const limit = lastCloser - afterOpener;
      for (scanRe.lastIndex = 0; (m.scan = scanRe.exec(rest)) !== null && !(m.scan.index > limit);) {
        const s = m.scan;
        if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
        if (b = g.length, s[3] || s[4]) { need += b; continue; }
        else if (s[5] || s[6] || canAlsoClose) {
          if (sameAsPrev && (s[5] || s[6])) break;
          if (totalRun % 3 && !((totalRun + b) % 3)) { spare += b; continue; }
        }
        if (need -= b, need > 0) continue;
        b = Math.min(b, b + need + spare);
        const leadLen = s[0].codePointAt(0) > 0xFFFF ? 2 : 1;
        const raw = src.slice(0, runLen + s.index + leadLen + b);
        if (Math.min(runLen, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (!m) return;
    let text = m[2].replace(R.newLineCharGlobal, ' ');
    const hasNonSpace = R.nonSpaceChar.test(text);
    const padded = R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }

  del(src, masked, prevChar = '') {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const lastUnit = m[0].charCodeAt(m[0].length - 1);
      const runLen = m[0].length - (lastUnit >= 0xDC00 && lastUnit <= 0xDFFF ? 2 : 1);
      let found, foundLen;
      let need = runLen;
      const scanRe = INLINE.delRDelim;
      const lastCloser = lastDelCloser(this, masked);
      const afterOpener = masked.length - src.length + runLen;
      if (lastCloser < afterOpener) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const limit = lastCloser - afterOpener;
      for (scanRe.lastIndex = 0; (m.scan = scanRe.exec(rest)) !== null && !(m.scan.index > limit);) {
        const s = m.scan;
        if (found = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !found || (foundLen = found.length, foundLen !== runLen)) continue;
        if (s[3] || s[4]) { need += foundLen; continue; }
        if (need -= foundLen, need > 0) continue;
        foundLen = Math.min(foundLen, foundLen + need);
        const leadLen = s[0].codePointAt(0) > 0xFFFF ? 2 : 1;
        const raw = src.slice(0, runLen + s.index + leadLen + foundLen);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return {
      type: 'link', raw: m[0], text, href, autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  url(src) {
    const m = INLINE.url.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? '';
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return {
      type: 'link', raw: m[0], text, href, autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  inlineText(src) {
    const n = src.length;
    if (n === 0) return;
    const c0 = src.charCodeAt(0);
    // A lone non-alphanumeric character before a mailto:/xmpp: address is
    // a text token of its own.
    if (!isAlnumCode(c0) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
      return this.textToken(src, 0, 1);
    }
    let i;
    if (c0 === 96) { // a backtick run is consumed as text when no code span formed
      i = 1;
      while (i < n && src.charCodeAt(i) === 96) i++;
    } else if (c0 === 126) { // same for a tilde run
      i = 1;
      while (i < n && src.charCodeAt(i) === 126) i++;
    } else {
      i = 1;
    }
    // Where an email address could start: the smallest position at or
    // after `i` from which a run of email characters reaches an `@`. A
    // run may start inside a longer run (the lookahead only needs the
    // characters from the start position to the `@` to be email
    // characters), so for each `@` the maximal run before it is found
    // first and the start is derived from it.
    let emailStop = n + 1;
    let at = src.indexOf('@', i);
    while (at !== -1) {
      let r = at - 1;
      while (r >= 0 && isEmailChar(src.charCodeAt(r))) r--;
      const runStart = r + 1;
      if (runStart <= i && i <= at - 1) { emailStop = i; break; }
      if (runStart > i) { emailStop = runStart; break; }
      at = src.indexOf('@', at + 1);
    }
    let end = emailStop;
    TEXT_STOP_RE.lastIndex = i;
    let m;
    while ((m = TEXT_STOP_RE.exec(src)) !== null) {
      // A mailto:/xmpp: address at the very start of the scan has no
      // separator character before it, so it does not end the token.
      if (m.index === i && (m[0] === 'mailto:' || m[0] === 'xmpp:')) continue;
      if (m.index < end) end = m.index;
      break;
    }
    if (end > n) end = n;
    return this.textToken(src, 0, end);
  }

  textToken(src, start, end) {
    const raw = src.slice(start, end);
    const inRaw = this.lexer.state.inRawBlock;
    return {
      type: 'text', raw,
      text: inRaw ? raw : unescapeEntities(raw),
      escaped: inRaw,
    };
  }
}

// The next place a text token can end: a character that starts another
// inline token, a hard break, a `www.` address (only after whitespace or
// `*`, `_`, `~`, `(`), a URL scheme, or a mailto:/xmpp: address (only
// when the character before it is not alphanumeric). Email addresses are
// handled separately, via the run starts computed above.
const TEXT_STOP_RE = /[\\<!\[`*~_]| {2,}\n|(?<![^\s*_~(])www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?<=[^a-zA-Z0-9])mailto:|(?<=[^a-zA-Z0-9])xmpp:/g;
// Is the code unit an ASCII letter or digit?
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Can the code unit appear inside a bare email address?
function isEmailChar(c) {
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37
    || c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61
    || c === 63 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// ---------------------------------------------------------------------------
// Lexer: block pass, then the queued inline pass
// ---------------------------------------------------------------------------
class Lexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.hasLinks = false;
    this.state = {
      inLink: false, inRawBlock: false, linkEmitted: false,
      linkParenPossible: true, top: true,
    };
    this.inlineQueue = [];
    this.tok = new FullTok();
    this.tok.lexer = this;
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(R.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline source for the second pass and hand back its token
  // array (filled in later, once every link definition is known).
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineMasked(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineMasked(src, tokens) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskSource(this, src) : src;
    // The extended-autolink tokenizer can only match when the source
    // holds a scheme, `www.`, an `@`, or a mailto:/xmpp: address; without
    // any of those, every word position can skip it outright.
    const mayHaveUrl = src.includes('://') || src.includes('www.') || src.includes('@')
      || src.includes('mailto:') || src.includes('xmpp:');
    if (needsMask) rememberMask(this.tok, masked);
    try {
      return this.inlineLoop(src, masked, tokens, mayHaveUrl);
    } finally {
      if (needsMask) forgetMask(this.tok);
    }
  }

  inlineLoop(src, masked, tokens, mayHaveUrl) {
    let lastWasText = false;
    let prevChar = '';
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!lastWasText) prevChar = '';
      lastWasText = false;
      let tok;
      // Dispatch on the first character: every inline tokenizer's pattern
      // is anchored and can only match when the text starts a certain way,
      // so most positions try exactly one tokenizer instead of all eleven.
      const c = src.charCodeAt(0);
      if (c === 92) { // backslash: escape, then a hard break
        if (tok = this.tok.escape(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (tok = this.tok.br(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (c === 60) { // <: raw HTML tag, then an autolink
        if (tok = this.tok.tag(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (tok = this.tok.autolink(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (c === 91 || (c === 33 && src.charCodeAt(1) === 91)) { // [ or ![
        if (tok = this.tok.link(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (tok = this.tok.reflink(src, this.links)) {
          src = src.substring(tok.raw.length);
          const last = tokens[tokens.length - 1];
          if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
          else tokens.push(tok);
          continue;
        }
      } else if (c === 42 || c === 95) { // * _
        if (tok = this.tok.emStrong(src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        // An email address can start with `_`; marked tries the extended
        // autolink after emphasis fails, so this branch does too.
        if (c === 95 && mayHaveUrl && !this.state.inLink
          && (tok = this.tok.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (c === 96) { // backtick: code span
        if (tok = this.tok.codespan(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (c === 126) { // ~: strikethrough
        if (tok = this.tok.del(src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (c === 32) { // space: only a hard break can start here
        if (tok = this.tok.br(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (mayHaveUrl && !this.state.inLink && (
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
        || c === 46 || c === 95 || c === 43 || c === 45)) {
        // a word character: a GFM extended autolink may start here
        if (tok = this.tok.url(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      }
      if (tok = this.tok.inlineText(src)) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        lastWasText = true;
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }

  // Does `src` contain a link (inline or reference) that is not an image
  // and whose label is defined? Used while masking, to decide which
  // bracket spans can hide emphasis closers.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const whole = m[0];
      const open = whole.lastIndexOf('[');
      const defined = Object.hasOwn(this.links, normalizeLabel(whole.slice(open + 1, -1)));
      if (!(whole.charAt(0) === '!' || !defined) && !(open > 1 && this.linkInText(whole.slice(1, open - 1)))) return true;
    }
    return false;
  }

  blockTokens(src, tokens = [], inQuote = false) {
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      // Dispatch on the first character: most block tokenizers are
      // anchored and need a specific first character, so a line starting
      // with anything else can skip them outright. Table, setext heading,
      // paragraph and text can start with any character and are always
      // tried, in the original order.
      const c0 = src.charCodeAt(0);
      let tSpace = true, tCode = true, tFences = true, tHeading = true, tHr = true,
        tBlockquote = true, tList = true, tHtml = true, tDef = true;
      if (c0 !== 32 && c0 !== 9 && c0 !== 10) {
        tSpace = false; tCode = false;
        tFences = c0 === 96 || c0 === 126;
        tHeading = c0 === 35;
        tHr = c0 === 45 || c0 === 95 || c0 === 42;
        tBlockquote = c0 === 62;
        tList = c0 === 45 || c0 === 43 || c0 === 42 || (c0 >= 48 && c0 <= 57);
        tHtml = c0 === 60;
        tDef = c0 === 91;
      } else if (c0 === 10) {
        // A blank line: only the space tokenizer can match.
        tCode = false; tFences = false; tHeading = false; tHr = false;
        tBlockquote = false; tList = false; tHtml = false; tDef = false;
      }
      if (tSpace && (tok = this.tok.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if (tCode && (tok = this.tok.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (tFences && (tok = this.tok.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tHeading && (tok = this.tok.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tHr && (tok = this.tok.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tBlockquote && (tok = this.tok.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tList && (tok = this.tok.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tHtml && (tok = this.tok.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tDef && (tok = this.tok.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          if (!this.links[tok.tag]) { this.links[tok.tag] = { href: tok.href, title: tok.title }; this.hasLinks = true; }
          tokens.push(tok);
        }
        continue;
      }
      if (tok = this.tok.table(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tok.lheading(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      const chunk = src;
      if (this.state.top && (tok = this.tok.paragraph(chunk))) {
        const last = tokens[tokens.length - 1];
        if (inQuote && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        inQuote = chunk.length !== src.length;
        src = src.substring(tok.raw.length);
        continue;
      }
      if (tok = this.tok.text(src)) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Renderer: tokens -> HTML strings. The text renderer is the same shape
// but renders inline tokens to plain text (used for image alt text).
// ---------------------------------------------------------------------------
class Render {
  code(tok) {
    const lang = (tok.lang || '').match(R.notSpaceStart)?.[0];
    const body = tok.text ? tok.text.replace(R.endingNewline, '') + '\n' : '';
    const esc = escHtml(body, true);
    if (lang) return `<pre><code class="language-${escHtml(lang)}">${esc}</code></pre>\n`;
    return `<pre><code>${esc}</code></pre>\n`;
  }

  blockquote(tok) {
    return `<blockquote>\n${this.parser.parse(tok.tokens)}</blockquote>\n`;
  }

  html(tok) { return tok.text; }

  def() { return ''; }

  heading(tok) {
    return `<h${tok.depth}>${this.parser.parseInline(tok.tokens)}</h${tok.depth}>\n`;
  }

  hr() { return '<hr>\n'; }

  list(tok) {
    let body = '';
    for (const item of tok.items) body += this.listitem(item);
    const tag = tok.ordered ? 'ol' : 'ul';
    const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
    return `<${tag}${start}>\n${body}</${tag}>\n`;
  }

  listitem(tok) {
    return `<li>${this.parser.parse(tok.tokens)}</li>\n`;
  }

  checkbox(tok) {
    return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }

  paragraph(tok) {
    return `<p>${this.parser.parseInline(tok.tokens)}</p>\n`;
  }

  table(tok) {
    let head = '';
    for (const cell of tok.header) head += this.tablecell(cell);
    head = this.tablerow({ text: head });
    let body = '';
    for (const row of tok.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }

  tablerow(tok) { return `<tr>\n${tok.text}</tr>\n`; }

  tablecell(tok) {
    const inner = this.parser.parseInline(tok.tokens);
    const tag = tok.header ? 'th' : 'td';
    return (tok.align ? `<${tag} align="${tok.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  strong(tok) { return `<strong>${this.parser.parseInline(tok.tokens)}</strong>`; }

  em(tok) { return `<em>${this.parser.parseInline(tok.tokens)}</em>`; }

  codespan(tok) { return `<code>${escHtml(tok.text, true)}</code>`; }

  br() { return '<br>'; }

  del(tok) { return `<del>${this.parser.parseInline(tok.tokens)}</del>`; }

  link(tok) {
    const inner = tok.autolink ? escHtml(tok.text, true) : this.parser.parseInline(tok.tokens);
    const href = encodeHref(tok.href);
    if (href === null) return inner;
    let out = `<a href="${escHtml(href, tok.autolink)}"`;
    if (tok.title) out += ` title="${escHtml(tok.title)}"`;
    return out + '>' + inner + '</a>';
  }

  image(tok) {
    let alt = tok.text;
    if (tok.tokens) alt = this.parser.parseInline(tok.tokens, this.parser.textRenderer);
    const src = encodeHref(tok.href);
    if (src === null) return escHtml(alt);
    let out = `<img src="${escHtml(src)}" alt="${escHtml(alt)}"`;
    if (tok.title) out += ` title="${escHtml(tok.title)}"`;
    return out + '>';
  }

  text(tok) {
    if ('tokens' in tok && tok.tokens) return this.parser.parseInline(tok.tokens);
    if ('escaped' in tok && tok.escaped) return tok.text;
    return escHtml(tok.text);
  }
}

class TextRender {
  strong(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  em(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  codespan(tok) { return tok.text; }
  del(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  html(tok) { return tok.text; }
  text(tok) { return tok.text; }
  link(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  image(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  br() { return ''; }
  checkbox(tok) { return tok.raw; }
}

// ---------------------------------------------------------------------------
// Parser: walks block tokens (or inline tokens) through a renderer
// ---------------------------------------------------------------------------
class Parser {
  constructor() {
    this.renderer = new Render();
    this.renderer.parser = this;
    this.textRenderer = new TextRender();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'space': break;
        case 'hr': out += this.renderer.hr(tok); break;
        case 'heading': out += this.renderer.heading(tok); break;
        case 'code': out += this.renderer.code(tok); break;
        case 'table': out += this.renderer.table(tok); break;
        case 'blockquote': out += this.renderer.blockquote(tok); break;
        case 'list': out += this.renderer.list(tok); break;
        case 'checkbox': out += this.renderer.checkbox(tok); break;
        case 'html': out += this.renderer.html(tok); break;
        case 'def': out += this.renderer.def(tok); break;
        case 'paragraph': out += this.renderer.paragraph(tok); break;
        case 'text': out += this.renderer.text(tok); break;
        default: throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'escape': out += renderer.text(tok); break;
        case 'html': out += renderer.html(tok); break;
        case 'link': out += renderer.link(tok); break;
        case 'image': out += renderer.image(tok); break;
        case 'checkbox': out += renderer.checkbox(tok); break;
        case 'strong': out += renderer.strong(tok); break;
        case 'em': out += renderer.em(tok); break;
        case 'codespan': out += renderer.codespan(tok); break;
        case 'br': out += renderer.br(tok); break;
        case 'del': out += renderer.del(tok); break;
        case 'text': out += renderer.text(tok); break;
        default: throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  const parser = new Parser();
  return parser.parse(tokens);
}
