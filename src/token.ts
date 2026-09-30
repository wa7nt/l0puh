/**
 * Positions and tokens.
 *
 * There is no keyword list.  Every bare word is an `Ident`, and the parser
 * matches on the text.  That keeps `list` and `import` usable as variable
 * names (Python lets you do this) and means the lexer has no table to grow when
 * a new builtin is added.
 */

export const TT = {
  // Trivia and structure
  Number: "Number",
  String: "String",
  Ident: "Ident",
  Newline: "Newline",
  Indent: "Indent",
  Dedent: "Dedent",
  EOF: "EOF",

  // Punctuation
  LParen: "(",
  RParen: ")",
  LBracket: "[",
  RBracket: "]",
  LBrace: "{",
  RBrace: "}",
  Comma: ",",
  Colon: ":",
  Semicolon: ";",
  Dot: ".",
  Arrow: "->",
  Question: "?",
  At: "@",

  // Operators
  Assign: "=",
  Eq: "==",
  Ne: "!=",
  Lt: "<",
  Gt: ">",
  Le: "<=",
  Ge: ">=",
  Plus: "+",
  Minus: "-",
  Star: "*",
  Slash: "/",
  SlashSlash: "//",
  Percent: "%",
  DStar: "**",
  Amp: "&",
  Pipe: "|",
  Caret: "^",
  Tilde: "~",
  Shl: "<<",
  Shr: ">>",
  // Compound assignment.  These are their own token types rather than a flag on
  // `=`, so the parser can hand the operator straight to code generation; a
  // desugared `a[0] += 1` would evaluate the index twice.
  PlusEq: "+=",
  MinusEq: "-=",
  StarEq: "*=",
  SlashEq: "/=",
  SlashSlashEq: "//=",
  PercentEq: "%=",
  DStarEq: "**=",
  AmpEq: "&=",
  PipeEq: "|=",
  CaretEq: "^=",
  ShlEq: "<<=",
  ShrEq: ">>=",
  Ellipsis: "...",
} as const;

export type TokenType = (typeof TT)[keyof typeof TT];

/** One piece of a string literal: either plain text or an interpolated source. */
export type StringPart =
  | { kind: "lit"; value: string }
  | { kind: "expr"; src: string; line: number; col: number };

export type TokenValue = number | string | StringPart[] | null;

export interface Token {
  type: TokenType;
  /**
   * A `Number` token carries its value, an `Ident` its text, a `String` its
   * parts.  Operators carry the null and are identified by `type` alone.
   */
  value: TokenValue;
  line: number;
  col: number;
}

/**
 * Longest-match-first, so `**=` beats `**` and `==` beats `=`.  The compound
 * assignments come before the two-character operators they extend, which is the
 * whole reason they are listed here rather than being derived at run time.
 */
export const OPERATORS: readonly TokenType[] = [
  TT.Ellipsis,
  // compound assignment: must precede the operators they extend
  TT.PlusEq,
  TT.MinusEq,
  TT.StarEq,
  TT.SlashEq,
  TT.SlashSlashEq,
  TT.PercentEq,
  TT.DStarEq,
  TT.AmpEq,
  TT.PipeEq,
  TT.CaretEq,
  TT.ShlEq,
  TT.ShrEq,
  // two-character
  TT.DStar,
  TT.Eq,
  TT.Ne,
  TT.Le,
  TT.Ge,
  TT.Arrow,
  TT.SlashSlash,
  TT.Shl,
  TT.Shr,
  // one-character
  TT.Assign,
  TT.Plus,
  TT.Minus,
  TT.Star,
  TT.Slash,
  TT.Percent,
  TT.Amp,
  TT.Pipe,
  TT.Caret,
  TT.Tilde,
  TT.Lt,
  TT.Gt,
  TT.LParen,
  TT.RParen,
  TT.LBracket,
  TT.RBracket,
  TT.LBrace,
  TT.RBrace,
  TT.Comma,
  TT.Colon,
  TT.Semicolon,
  TT.Dot,
  TT.Question,
  TT.At,
];

/** Tokens that suppress the end-of-line token and let indentation ride by. */
export const OPENERS: readonly TokenType[] = [TT.LParen, TT.LBracket, TT.LBrace];
export const CLOSERS: readonly TokenType[] = [TT.RParen, TT.RBracket, TT.RBrace];

/** Operator indices, spelled out for the VM's integer switch. */
export const BIN_ADD = 0;
export const BIN_SUB = 1;
export const BIN_MUL = 2;
export const BIN_DIV = 3;
export const BIN_FLOORDIV = 4;
export const BIN_MOD = 5;
export const BIN_POW = 6;
export const BIN_EQ = 7;
export const BIN_NE = 8;
export const BIN_LT = 9;
export const BIN_LE = 10;
export const BIN_GT = 11;
export const BIN_GE = 12;
export const BIN_AND = 13;
export const BIN_OR = 14;
export const BIN_XOR = 15;
export const BIN_SHL = 16;
export const BIN_SHR = 17;
export const BIN_IN = 18;
export const BIN_NOTIN = 19;

/** Unary operator indices. */
export const UN_NEG = 0;
export const UN_POS = 1;
export const UN_INVERT = 2;
export const UN_NOT = 3;
