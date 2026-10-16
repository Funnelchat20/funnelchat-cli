/**
 * CSV the way spreadsheets read it: comma-separated, `"` quoting when needed, CRLF line ends (RFC 4180),
 * and a UTF-8 BOM so Excel shows accents right.
 *
 * Contact data comes from WhatsApp users, so a cell could start with `=`, `+`, `-` or `@` and run as a
 * formula when the file is opened in a spreadsheet. Those cells get a leading `'` (OWASP's advice);
 * plain numbers like `-5` or `+5491100000000` are left alone.
 */
export const CSV_BOM = '﻿';

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
