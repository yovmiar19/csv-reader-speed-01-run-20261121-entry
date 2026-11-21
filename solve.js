// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for {text, header}, but reads with indexOf jumps
// instead of one character at a time.
//
// Strategy, per line: one indexOf('\n') finds the line end, and one
// indexOf('\r') says whether the line holds a stray CR. Fields are read one
// by one, and an unquoted field on a line with no stray CR ends at the next
// comma or at the line's end, which is a single indexOf(',') inlined in the
// loop (a per-field indexOf + slice beats split(',') on these short fields).
// A quoted field is scanned with indexOf('"') (doubled '""' collapse to one
// '"', CRLF or a lone CR inside becomes '\n'). Only a line with a stray CR,
// junk after a closing quote, or a quote that never closes needs the
// three-way scan for ',', '\n' and '\r'. Field results travel in shared
// locals, not one object per field. Every error the reference records (stray_cr, quote_junk,
// unterminated_quote, short_row, long_row) is recorded with the same
// {code, line, row} and in the same order, and line counts exactly as the
// reference counts it: every LF, every CRLF and every CR inside quotes.
//
// Pure: fresh state per call, nothing kept between cases.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Line the record being read starts on, and its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // How the field just read ended, and, for a junk read, how many characters
  // it kept. Shared locals: no object per field.
  let ended = END;
  let added = 0;

  // Line state for the line pos is on. nl: index of the '\n' ending it (n
  // when the line is the last and has none). segEnd: nl, or nl - 1 when the
  // line ends CRLF. strayCr: a '\r' stands inside [pos, segEnd).
  let nl = -1;
  let segEnd = -1;
  let strayCr = false;

  function computeLine() {
    nl = text.indexOf('\n', pos);
    segEnd = nl === -1 ? n : nl;
    if (nl !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
    const r = text.indexOf('\r', pos);
    strayCr = r !== -1 && r < segEnd;
  }

  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break, setting `ended` (and `added`, the characters kept). A CR not
  // followed by LF is dropped (stray_cr) and the field goes on. Used for
  // junk after a closing quote and for fields on a line that holds a stray
  // CR; everywhere else the field loop reads with one indexOf(',').
  function readUnquoted(value) {
    added = 0;
    for (;;) {
      let next = n;
      let kind = END;
      const comma = text.indexOf(',', pos);
      if (comma !== -1 && comma < next) { next = comma; kind = COMMA; }
      const lf = text.indexOf('\n', pos);
      if (lf !== -1 && lf < next) { next = lf; kind = LINE_BREAK; }
      const cr = text.indexOf('\r', pos);
      if (cr !== -1 && cr < next) { next = cr; kind = LINE_BREAK; }
      if (kind === LINE_BREAK && next < n && text.charCodeAt(next) === 13 && text.charCodeAt(next + 1) !== 10) {
        // A lone CR: dropped, stray_cr, and the field continues past it.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (next > pos) { value += text.slice(pos, next); added += next - pos; }
        pos = next + 1;
        continue;
      }
      if (next > pos) { value += text.slice(pos, next); added += next - pos; }
      if (kind === COMMA) {
        pos = next + 1;
        ended = COMMA;
        return value;
      }
      if (kind === LINE_BREAK) {
        pos = next + (text.charCodeAt(next) === 13 ? 2 : 1);
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      pos = n;
      ended = END;
      return value;
    }
  }

  // Appends text[a..b) to `value`, turning each CRLF or lone CR into LF and
  // counting the line breaks it holds; `extra` (one '"' for a doubled quote)
  // is appended after it. When `clean` the segment holds no CR or LF at all
  // (it lies inside the current line, which has no stray CR), so it is a
  // plain slice.
  function appendQuoted(value, a, b, extra, clean) {
    if (a === b) return extra === null ? value : value + extra;
    if (clean) {
      value += text.slice(a, b);
      return extra === null ? value : value + extra;
    }
    const hasLf = text.indexOf('\n', a);
    const hasCr = text.indexOf('\r', a);
    if ((hasLf === -1 || hasLf >= b) && (hasCr === -1 || hasCr >= b)) {
      value += text.slice(a, b);
      return extra === null ? value : value + extra;
    }
    const seg = text.slice(a, b);
    let breaks = 0;
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c === 13) breaks += 1;
      else if (c === 10 && (i === 0 || seg.charCodeAt(i - 1) !== 13)) breaks += 1;
    }
    line += breaks;
    value += seg.replace(/\r\n|\r/g, '\n');
    return extra === null ? value : value + extra;
  }

  // Reads a quoted field whose opening quote is at pos, returning its value
  // and setting `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos = open + 1;
    let value = '';
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      // The segment lies inside the current line, which holds no stray CR,
      // when it ends at or before the line's end: then it holds no CR or LF.
      const clean = !strayCr && q <= segEnd;
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one '"' in the value, and the field goes on.
        value = appendQuoted(value, segStart, q, '"', clean);
        pos = q + 2;
        segStart = q + 2;
        continue;
      }
      value = appendQuoted(value, segStart, q, null, clean);
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    computeLine();

    // Slow path: the record holds a quote or a stray CR.
    const fields = [];
    let quoted = false;
    let fieldValue;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const lineBefore = line;
        fieldValue = readQuoted();
        // A quoted field may have ended on another line: refresh the line
        // only when it did (line moved); on the same line the state stands.
        if (ended === COMMA && line !== lineBefore) computeLine();
      } else if (strayCr) {
        quoted = false;
        fieldValue = readUnquoted('');
      } else {
        // An unquoted field on a line with no stray CR: the next comma or
        // the line's end, one indexOf(',') away.
        quoted = false;
        const comma = text.indexOf(',', pos);
        if (comma !== -1 && comma < segEnd) {
          fieldValue = text.slice(pos, comma);
          pos = comma + 1;
          ended = COMMA;
        } else {
          fieldValue = text.slice(pos, segEnd);
          if (nl === -1) {
            pos = n;
            ended = END;
          } else {
            pos = nl + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        }
      }
      fields.push(fieldValue);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
