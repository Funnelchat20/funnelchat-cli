import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../src/export/csv.js';

describe('csv', () => {
  it('quotes what needs quoting', () => {
    expect(csvCell('simple')).toBe('simple');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvCell('dos\nlíneas')).toBe('"dos\nlíneas"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('neutralizes formulas but leaves plain numbers alone', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('+54 9 11 x')).toBe("'+54 9 11 x");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('+5491100000000')).toBe('+5491100000000');
    expect(csvCell('3.14')).toBe('3.14');
  });

  it('ends rows with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
  });
});
