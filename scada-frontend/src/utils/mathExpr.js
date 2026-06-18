/**
 * Tiny safe expression evaluator for per-panel value transforms.
 *
 * Grammar (recursive descent):
 *   expr    := term  (('+' | '-') term)*
 *   term    := power (('*' | '/') power)*
 *   power   := unary ('^' unary)*           // right-associative
 *   unary   := ('+' | '-') unary | atom
 *   atom    := NUMBER
 *            | IDENT '(' expr (',' expr)* ')'
 *            | IDENT
 *            | '(' expr ')'
 *
 * Recognises the variable `value` and a small set of functions.
 * No `eval`, no `Function`, no DOM / prototype access — input strings cannot
 * execute arbitrary code.
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

function parse(tokens) {
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (type) => {
    const t = tokens[pos]
    if (!t || t.type !== type) throw new Error(`Expected ${type}, got ${t ? t.type : 'end of expression'}`)
    pos++
    return t
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

  const node = parseExpr()
  if (pos !== tokens.length) throw new Error(`Unexpected token after expression: ${tokens[pos].type}`)
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
