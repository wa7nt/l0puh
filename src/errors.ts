/**
 * One error type for the whole front end, carrying the position so the CLI can
 * print a caret under the offending character instead of a stack trace.
 */
export class L0pError extends Error {
  readonly line: number;
  readonly col: number;
  readonly file: string | null;

  constructor(message: string, line = 0, col = 0, file: string | null = null) {
    super(message);
    this.name = "L0pError";
    this.line = line;
    this.col = col;
    this.file = file;
  }

  /** `file:line:col: message`, omitting the file when there is none. */
  prefix(): string {
    if (this.file === null) return `line ${this.line}, col ${this.col}`;
    return `${this.file}:${this.line}:${this.col}`;
  }

  /** The message, then the source line and a caret. */
  format(src?: string): string {
    const head = `${this.prefix()}: ${this.message}`;
    if (src === undefined || this.line < 1) return head;
    const lineText = src.split("\n")[this.line - 1];
    if (lineText === undefined) return head;
    const caret = " ".repeat(Math.max(0, this.col - 1)) + "^";
    return `${head}\n  ${lineText}\n  ${caret}`;
  }
}
