'use strict';
/**
 * lib/profile-validator.js — THE authoritative validation pipeline for
 * profiles.json (and for arbitrary editor text being considered for it).
 * ─────────────────────────────────────────────────────────────────────
 *
 *   Raw text
 *     -> encoding check (valid UTF-8?)
 *     -> JSON syntax check (strict JSON.parse, diagnosed with jsonc-parser)
 *     -> JSON Schema validation (ajv, lib/profile-schema.js)
 *     -> business-rule validation (things a schema can't conveniently say)
 *     -> { valid, syntax_valid, schema_valid, application_valid, errors }
 *
 * This module is pure — it never touches the filesystem. Every caller
 * (startup load, save, import, editor "Validate" button, repair preview)
 * routes through validateProfilesText() so there is exactly one place
 * that decides whether a profiles.json is trustworthy.
 */
const Ajv = require('ajv');
const jsonc = require('jsonc-parser');
const { profilesStoreSchema } = require('./profile-schema');

const ajv = new Ajv({ allErrors: true, strict: false });
const validateStoreSchema = ajv.compile(profilesStoreSchema);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Convert a 0-based character offset into 1-based { line, column }. */
function offsetToLineColumn(text, offset) {
  let line = 1;
  let col = 1;
  const max = Math.min(offset, text.length);
  for (let i = 0; i < max; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

/** Convert an ajv instancePath ("/profiles/mon/channels/ch1/schedule/2/time")
 *  into the JSONPath-flavored string used throughout this system
 *  ("$.profiles.mon.channels.ch1.schedule[2].time"). */
function instancePathToJsonPath(instancePath) {
  if (!instancePath) return '$';
  const segments = instancePath.split('/').filter((s) => s.length > 0).map((s) =>
    s.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  let out = '$';
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
    } else {
      out += `.${seg}`;
    }
  }
  return out;
}

function makeError({ type, message, path, line, column, severity, recoverable, field }) {
  return {
    type,
    message,
    path: path || '$',
    line: line ?? null,
    column: column ?? null,
    severity: severity || 'error',
    recoverable: recoverable !== undefined ? recoverable : false,
    field: field || null,
  };
}

// ---------------------------------------------------------------------------
// Layer 0 — encoding
// ---------------------------------------------------------------------------

/**
 * Verify that a raw Buffer decodes as valid, non-lossy UTF-8. Returns
 * { ok, text, errors }. If the buffer contains invalid byte sequences,
 * ok is false and `text` is a best-effort decode (with U+FFFD markers)
 * used only for diagnostics — never treated as trustworthy content.
 */
function checkEncoding(buffer) {
  const errors = [];
  // A strict TextDecoder throws on the first invalid sequence; that only
  // tells us "somewhere" is broken, so we also do a lossy decode + re-encode
  // round-trip to point at roughly where the bytes stop matching.
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(buffer);
    return { ok: true, text, errors };
  } catch {
    const lossyText = buffer.toString('utf8'); // replaces bad bytes with U+FFFD
    const badIndex = lossyText.indexOf('\uFFFD');
    const { line, column } = badIndex >= 0
      ? offsetToLineColumn(lossyText, badIndex)
      : { line: null, column: null };
    errors.push(makeError({
      type: 'encoding',
      message: 'File is not valid UTF-8 — it contains malformed or non-UTF-8 byte sequences.',
      path: '$',
      line,
      column,
      severity: 'error',
      recoverable: true,
    }));
    return { ok: false, text: lossyText, errors };
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — syntax
// ---------------------------------------------------------------------------

/** Map jsonc-parser's numeric ParseErrorCode to a human sentence. */
function describeParseError(code) {
  const name = jsonc.printParseErrorCode(code);
  const map = {
    InvalidSymbol: 'Invalid symbol or unexpected token',
    InvalidNumberFormat: 'Malformed number',
    PropertyNameExpected: 'Expected a property name (a quoted string)',
    ValueExpected: 'Expected a value here',
    ColonExpected: "Expected ':' after property name",
    CommaExpected: "Missing comma ','",
    CommaOrCloseBacketExpected: "Expected ',' or closing ']'",
    CloseBraceExpected: "Missing closing '}'",
    CloseBracketExpected: "Missing closing ']'",
    EndOfFileExpected: 'Unexpected trailing content after the JSON value ends',
    InvalidCommentToken: 'Comments are not allowed in JSON',
    UnexpectedEndOfComment: 'Unterminated comment',
    UnexpectedEndOfString: 'Unterminated string literal',
    UnexpectedEndOfNumber: 'Unexpected end of number',
    InvalidUnicode: 'Invalid unicode escape sequence',
    InvalidEscapeCharacter: 'Invalid escape sequence',
    InvalidCharacter: 'Invalid character',
  };
  return map[name] || `JSON syntax error (${name})`;
}

/** Walk the token stream looking for duplicate keys within the same object.
 *  JSON.parse silently keeps the *last* value for a repeated key, which can
 *  hide a real authoring mistake, so we surface it explicitly. */
function findDuplicateKeys(text) {
  const errors = [];
  const stack = [];
  try {
    jsonc.visit(text, {
      onObjectBegin: () => stack.push(new Set()),
      onObjectEnd: () => stack.pop(),
      onObjectProperty: (property, offset) => {
        const seen = stack[stack.length - 1];
        if (!seen) return;
        if (seen.has(property)) {
          const { line, column } = offsetToLineColumn(text, offset);
          errors.push(makeError({
            type: 'syntax',
            message: `Duplicate key "${property}" — a later occurrence silently overwrites the earlier one`,
            path: '$',
            line,
            column,
            severity: 'error',
            recoverable: true,
            field: property,
          }));
        }
        seen.add(property);
      },
    }, { disallowComments: true });
  } catch {
    // Best-effort diagnostic only; ignore visit failures on heavily broken input.
  }
  return errors;
}

/**
 * Layer 1: is this text parsable, strict JSON? Returns
 * { syntaxValid, parsed, errors }. `parsed` is only set when syntaxValid.
 */
function checkSyntax(text) {
  try {
    const parsed = JSON.parse(text);
    // JSON.parse succeeded — still check for duplicate keys, which is legal
    // JSON but a real authoring hazard the spec wants surfaced.
    const dupErrors = findDuplicateKeys(text);
    return { syntaxValid: dupErrors.length === 0, parsed, errors: dupErrors };
  } catch (parseErr) {
    // Use jsonc-parser to produce a precise, categorized diagnostic.
    const diagnostics = [];
    jsonc.parseTree(text, diagnostics, { disallowComments: true, allowTrailingComma: false });

    const errors = [];
    if (text.trim().length === 0) {
      errors.push(makeError({
        type: 'syntax',
        message: 'File is empty — expected a JSON object',
        path: '$',
        line: 1,
        column: 1,
        severity: 'error',
        recoverable: false,
      }));
    } else if (diagnostics.length > 0) {
      for (const d of diagnostics) {
        const { line, column } = offsetToLineColumn(text, d.offset);
        errors.push(makeError({
          type: 'syntax',
          message: describeParseError(d.error),
          path: '$',
          line,
          column,
          severity: 'error',
          recoverable: true,
        }));
      }
    } else {
      // jsonc-parser found nothing wrong (rare — e.g. a bare scalar like
      // `42` is valid JSON-with-comments-tolerant syntax but not our shape,
      // or the file is truncated mid-token). Fall back to V8's message.
      const posMatch = /position (\d+)/i.exec(parseErr.message);
      const lineMatch = /line (\d+)/i.exec(parseErr.message);
      const colMatch = /column (\d+)/i.exec(parseErr.message);
      let line = null;
      let column = null;
      if (posMatch) {
        ({ line, column } = offsetToLineColumn(text, Number(posMatch[1])));
      } else if (lineMatch && colMatch) {
        line = Number(lineMatch[1]);
        column = Number(colMatch[1]);
      } else {
        ({ line, column } = offsetToLineColumn(text, text.length));
      }
      errors.push(makeError({
        type: 'syntax',
        message: parseErr.message.replace(/^Unexpected /, 'Unexpected ') || 'Invalid JSON',
        path: '$',
        line,
        column,
        severity: 'error',
        recoverable: true,
      }));
    }
    return { syntaxValid: false, parsed: null, errors };
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — JSON Schema
// ---------------------------------------------------------------------------

function checkSchema(parsed) {
  const ok = validateStoreSchema(parsed);
  if (ok) return { schemaValid: true, errors: [] };
  const errors = (validateStoreSchema.errors || []).map((e) => {
    const path = instancePathToJsonPath(e.instancePath);
    let message = e.message || 'Schema validation failed';
    if (e.keyword === 'additionalProperties' && e.params && e.params.additionalProperty) {
      message = `Unexpected property "${e.params.additionalProperty}" is not allowed here`;
    } else if (e.keyword === 'pattern') {
      message = `Value does not match required format (${e.schema})`;
    } else if (e.keyword === 'required') {
      message = `Missing required field "${e.params.missingProperty}"`;
    } else if (e.keyword === 'type') {
      message = `Expected type "${e.params.type}"`;
    }
    return makeError({
      type: 'schema',
      message,
      path,
      severity: 'error',
      recoverable: true,
      field: e.instancePath.split('/').pop() || null,
    });
  });
  return { schemaValid: false, errors };
}

// ---------------------------------------------------------------------------
// Layer 3 — application / business rules (things JSON Schema can't say)
// ---------------------------------------------------------------------------

function checkBusinessRules(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') return { applicationValid: false, errors };

  const profiles = parsed.profiles || {};
  const order = Array.isArray(parsed.order) ? parsed.order : [];
  const profileIds = Object.keys(profiles);

  if (profileIds.length === 0) {
    errors.push(makeError({
      type: 'semantic',
      message: 'No profiles are defined — the bell scheduler has nothing to run',
      path: '$.profiles',
      severity: 'warning',
      recoverable: true,
    }));
  }

  for (const id of order) {
    if (!profiles[id]) {
      errors.push(makeError({
        type: 'semantic',
        message: `"order" references profile id "${id}" which does not exist in "profiles"`,
        path: '$.order',
        severity: 'error',
        recoverable: true,
        field: id,
      }));
    }
  }
  for (const id of profileIds) {
    if (!order.includes(id)) {
      errors.push(makeError({
        type: 'semantic',
        message: `Profile "${id}" exists but is not listed in "order" — it will never be shown or selectable`,
        path: `$.profiles.${id}`,
        severity: 'warning',
        recoverable: true,
        field: id,
      }));
    }
  }

  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== 'object' || !profile.channels || typeof profile.channels !== 'object') continue;
    for (const [chKey, ch] of Object.entries(profile.channels)) {
      if (!ch || typeof ch !== 'object' || !Array.isArray(ch.schedule)) continue;
      const seenTimes = new Set();
      ch.schedule.forEach((entry, idx) => {
        const time = typeof entry === 'string' ? entry : (entry && entry.time);
        if (typeof time !== 'string') return;
        if (seenTimes.has(time)) {
          errors.push(makeError({
            type: 'semantic',
            message: `Duplicate schedule time "${time}" in channel "${chKey}"`,
            path: `$.profiles.${id}.channels.${chKey}.schedule[${idx}]`,
            severity: 'error',
            recoverable: true,
            field: chKey,
          }));
        }
        seenTimes.add(time);
      });
      if (Array.isArray(ch.skip_dates)) {
        const seenDates = new Set();
        ch.skip_dates.forEach((d, idx) => {
          if (typeof d !== 'string') return;
          if (seenDates.has(d)) {
            errors.push(makeError({
              type: 'semantic',
              message: `Duplicate skip_date "${d}" in channel "${chKey}"`,
              path: `$.profiles.${id}.channels.${chKey}.skip_dates[${idx}]`,
              severity: 'warning',
              recoverable: true,
              field: chKey,
            }));
          }
          seenDates.add(d);
        });
      }
    }
  }

  const hasBlockingError = errors.some((e) => e.severity === 'error');
  return { applicationValid: !hasBlockingError, errors };
}

// ---------------------------------------------------------------------------
// Top-level pipeline
// ---------------------------------------------------------------------------

/**
 * Validate raw profiles.json TEXT (a string, already decoded). This is the
 * single entry point every caller (load, save, import, editor, repair
 * preview) should use.
 *
 * Returns:
 *   {
 *     valid, syntax_valid, schema_valid, application_valid,
 *     errors: [ {type, message, path, line, column, severity, recoverable, field} ],
 *     parsed:  the parsed object, only when syntax_valid is true
 *   }
 */
function validateProfilesText(text) {
  if (typeof text !== 'string') text = '';

  const syntax = checkSyntax(text);
  if (!syntax.syntaxValid) {
    return {
      valid: false,
      syntax_valid: false,
      schema_valid: false,
      application_valid: false,
      errors: syntax.errors,
      parsed: null,
    };
  }

  const schema = checkSchema(syntax.parsed);
  if (!schema.schemaValid) {
    return {
      valid: false,
      syntax_valid: true,
      schema_valid: false,
      application_valid: false,
      errors: [...syntax.errors, ...schema.errors],
      parsed: syntax.parsed,
    };
  }

  const business = checkBusinessRules(syntax.parsed);
  return {
    valid: business.applicationValid,
    syntax_valid: true,
    schema_valid: true,
    application_valid: business.applicationValid,
    errors: [...syntax.errors, ...business.errors],
    parsed: syntax.parsed,
  };
}

/** Validate a raw Buffer straight off disk (handles encoding first). */
function validateProfilesBuffer(buffer) {
  const enc = checkEncoding(buffer);
  if (!enc.ok) {
    return {
      valid: false,
      syntax_valid: false,
      schema_valid: false,
      application_valid: false,
      errors: enc.errors,
      parsed: null,
    };
  }
  return validateProfilesText(enc.text);
}

module.exports = {
  validateProfilesText,
  validateProfilesBuffer,
  checkEncoding,
  checkSyntax,
  checkSchema,
  checkBusinessRules,
  offsetToLineColumn,
  instancePathToJsonPath,
};
