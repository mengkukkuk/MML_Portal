/**
 * Tiny safe expression evaluator for per-panel value transforms and for the
 * conditions that decide what a mimic symbol shows.
 *
 * Grammar (recursive descent):
 *   cond    := or                           // compileCondition entry point
 *   or      := and ('or' and)*
 *   and     := not ('and' not)*
 *   not     := 'not' not | compare
 *   compare := expr ('>' | '<' | '>=' | '<=' | '==' | '!=') expr
 *   expr    := term  (('+' | '-') term)*    // compileExpr entry point
 *   term    := power (('*' | '/') power)*
 *   power   := unary ('^' unary)*           // right-associative
 *   unary   := ('+' | '-') unary | atom
 *   atom    := NUMBER
 *            | STRING                        // 'FAULT' or "FAULT"
 *            | IDENT '(' expr (',' expr)* ')'
 *            | IDENT
 *            | '(' expr ')'
 *
 * Recognises the variable `value` and a small set of functions.
 * No `eval`, no `Function`, no DOM / prototype access — input strings cannot
 * execute arbitrary code.
 *
 * The two entry points share one grammar on purpose: an engineer who has
 * learned `value / 10` for a Live panel transform can write `value > 80` for an
 * annunciator without learning a second language. They are separate entry
 * points rather than one because the *types* differ — a transform must yield a
 * number and a condition must yield a boolean, and each is a nonsense answer to
 * the other's question. Comparison sits above `expr`, so `compileExpr` still
 * rejects `value > 80` exactly as it did before this was added.
 */

const FUNCS = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
}

function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue }
    // Two-character comparisons first, or `>=` would tokenize as `>` then a
    // stray `=`.
    const pair = src.slice(i, i + 2)
    if (pair === '<=' || pair === '>=' || pair === '==' || pair === '!=') {
      tokens.push({ type: 'cmp', op: pair })
      i += 2
      continue
    }
    if (c === '<' || c === '>') { tokens.push({ type: 'cmp', op: c }); i++; continue }
    // A lone `=` is almost always a typo for `==` rather than a character
    // someone meant, so it is worth naming.
    if (c === '=') throw new Error(`Use '==' to compare, at position ${i}`)
    if ('+-*/^(),'.includes(c)) { tokens.push({ type: c }); i++; continue }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        // Allow `+`/`-` only directly after exponent marker.
        if ((src[j] === '+' || src[j] === '-') && !(j > i && (src[j - 1] === 'e' || src[j - 1] === 'E'))) break
        j++
      }
      const n = Number(src.slice(i, j))
      if (!Number.isFinite(n)) throw new Error(`Invalid number at position ${i}`)
      tokens.push({ type: 'num', value: n })
      i = j
      continue
    }
    // A quoted word — how a condition names a status a text column stores.
    // Both quote characters are accepted because there is no reason to make
    // someone remember which one this dialect chose, and no escape sequences
    // because a plant status is never `RUN\'s`; a literal runs to its closing
    // quote and that is the whole rule.
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      if (end === -1) throw new Error(`Unclosed ${c} quote at position ${i}`)
      tokens.push({ type: 'str', value: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++
      tokens.push({ type: 'ident', value: src.slice(i, j) })
      i = j
      continue
    }
    throw new Error(`Unexpected character '${c}' at position ${i}`)
  }
  return tokens
}

/**
 * Equality, with text compared as a *word* rather than as bytes.
 *
 * `value == 'fault'` holds for a column storing `'FAULT'` or `'Fault '`. Strict
 * equality is the obvious implementation and the wrong one here: the author of
 * the rule is reading the column in a picker or a spreadsheet, not in a hex
 * dump, and the failure it produces is the worst kind — a lamp that never
 * lights, with no error to explain why, because the rule *is* well formed. A
 * `char(8)` column pads with spaces, so trimming is the same argument.
 *
 * Numbers are untouched: `1` and `'1'` stay different, since a text column
 * holding digits is still text and conflating them would undo the column-type
 * decision made on the server.
 */
function sameWord(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  }
  return a === b
}

function parse(tokens, mode = 'number') {
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (type) => {
    const t = tokens[pos]
    if (!t || t.type !== type) throw new Error(`Expected ${type}, got ${t ? t.type : 'end of expression'}`)
    pos++
    return t
  }

  /** `peek()` is the keyword `word` — `and`/`or`/`not` are idents, not symbols. */
  const keyword = (word) => {
    const t = peek()
    return !!t && t.type === 'ident' && t.value === word
  }

  function parseOr() {
    let left = parseAnd()
    while (keyword('or')) {
      pos++
      const l = left, r = parseAnd()
      left = (s) => l(s) || r(s)
    }
    return left
  }

  function parseAnd() {
    let left = parseNot()
    while (keyword('and')) {
      pos++
      const l = left, r = parseNot()
      left = (s) => l(s) && r(s)
    }
    return left
  }

  function parseNot() {
    if (keyword('not')) {
      pos++
      const inner = parseNot()
      return (s) => !inner(s)
    }
    return parseCompare()
  }

  /**
   * The operator is required. A bare `value` as a condition would have to invent
   * a truthiness rule for numbers — and "is 0 false?" is a question a plant
   * engineer should never be asked to answer to get a lamp to light.
   */
  function parseCompare() {
    const left = parseExpr()
    const t = peek()
    if (!t || t.type !== 'cmp') {
      throw new Error("A condition needs a comparison, e.g. 'value > 80'")
    }
    pos++
    const right = parseExpr()
    switch (t.op) {
      case '>': return (s) => left(s) > right(s)
      case '<': return (s) => left(s) < right(s)
      case '>=': return (s) => left(s) >= right(s)
      case '<=': return (s) => left(s) <= right(s)
      case '==': return (s) => sameWord(left(s), right(s))
      default: return (s) => !sameWord(left(s), right(s))
    }
  }

  function parseExpr() {
    let left = parseTerm()
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = peek().type; pos++
      const right = parseTerm()
      const l = left, r = right
      left = op === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s)
    }
    return left
  }

  function parseTerm() {
    let left = parsePower()
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = peek().type; pos++
      const right = parsePower()
      const l = left, r = right
      left = op === '*' ? (s) => l(s) * r(s) : (s) => l(s) / r(s)
    }
    return left
  }

  function parsePower() {
    const base = parseUnary()
    if (peek() && peek().type === '^') {
      pos++
      const exp = parsePower() // right-associative
      return (s) => Math.pow(base(s), exp(s))
    }
    return base
  }

  function parseUnary() {
    if (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = peek().type; pos++
      const inner = parseUnary()
      return op === '-' ? (s) => -inner(s) : inner
    }
    return parseAtom()
  }

  function parseAtom() {
    const t = peek()
    if (!t) throw new Error('Unexpected end of expression')
    if (t.type === 'num') { pos++; return () => t.value }
    if (t.type === 'str') { pos++; return () => t.value }
    if (t.type === '(') {
      pos++
      const e = parseExpr()
      eat(')')
      return e
    }
    if (t.type === 'ident') {
      pos++
      // Function call: ident '(' args ')'
      if (peek() && peek().type === '(') {
        const name = t.value
        const fn = FUNCS[name]
        if (!fn) throw new Error(`Unknown function: ${name}`)
        pos++
        const args = []
        if (peek() && peek().type !== ')') {
          args.push(parseExpr())
          while (peek() && peek().type === ',') { pos++; args.push(parseExpr()) }
        }
        eat(')')
        return (s) => fn(...args.map((a) => a(s)))
      }
      // Bare identifier — only `value` is supported.
      if (t.value !== 'value') throw new Error(`Unknown variable: ${t.value} (use 'value')`)
      return (s) => s.value
    }
    throw new Error(`Unexpected token ${t.type}`)
  }

  const node = mode === 'condition' ? parseOr() : parseExpr()
  if (pos !== tokens.length) {
    const t = tokens[pos]
    throw new Error(`Unexpected token after expression: ${t.op ?? t.value ?? t.type}`)
  }
  return node
}

/**
 * Compile a math expression string.
 *   compileExpr('')           -> { ok: true,  fn: null }   // passthrough
 *   compileExpr('value * 2')  -> { ok: true,  fn: (v)=>... }
 *   compileExpr('value +')    -> { ok: false, error: '...' }
 *
 * Probes with value=1; rejects expressions that don't yield a finite number.
 */
export function compileExpr(src) {
  if (!src || !src.trim()) return { ok: true, fn: null }
  try {
    const node = parse(tokenize(src))
    const probe = node({ value: 1 })
    if (!Number.isFinite(probe)) return { ok: false, error: 'Expression must return a number' }
    return { ok: true, fn: (v) => node({ value: v }) }
  } catch (e) {
    return { ok: false, error: e?.message || 'Invalid expression' }
  }
}

/**
 * Compile a condition string — the test behind a coloured lamp or a lit
 * annunciator tile.
 *   compileCondition('')            -> { ok: true,  fn: null }   // no condition
 *   compileCondition('value > 80')  -> { ok: true,  fn: (v)=>bool }
 *   compileCondition('value')       -> { ok: false, error: '...' }
 *
 * Probes with value=1 to catch a parse that only fails on evaluation.
 */
export function compileCondition(src) {
  if (!src || !src.trim()) return { ok: true, fn: null }
  try {
    const node = parse(tokenize(src), 'condition')
    node({ value: 1 })
    return { ok: true, fn: (v) => node({ value: v }) === true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Invalid condition' }
  }
}

/**
 * Test a compiled condition against a reading.
 *
 * A reading is a finite number *or* a string — a symbol may be bound to a
 * status column, and `value == 'FAULT'` is the most direct rule anyone will
 * ever write for one. Anything else (null, NaN, a reading that never arrived)
 * answers **false**, never true: an unbound symbol and a symbol whose condition
 * is met must not look alike, and of the two possible mistakes, a lamp that
 * stays dark is the one an operator will investigate. A lamp that lights on
 * nothing is the one they learn to ignore.
 */
export function testCondition(fn, v) {
  if (fn == null) return false
  const usable = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
  if (!usable) return false
  try {
    return fn(v)
  } catch {
    return false
  }
}

/**
 * Apply a compiled expression to a value. Silently falls back to the raw
 * value on runtime failure (per product decision — panels never go blank).
 */
export function applyExpr(fn, v) {
  if (fn == null || v == null) return v
  try {
    const out = fn(v)
    return Number.isFinite(out) ? out : v
  } catch {
    return v
  }
}
