/**
 * String -> `Node` filter parser for the search route's `?filter=` query
 * param.
 *
 * `openapi.yaml` describes this param as "parsed by the framework's filter
 * module," but no such string grammar exists in
 * `@governance-connector-framework/core` -- that package only validates an
 * already-structured `Node` AST (`parseFilter`). This is the grammar that
 * was missing, written here rather than in core because it's an HTTP
 * concern (turning a query string into the AST core already understands),
 * not a connector-execution one.
 *
 * Deliberately narrow for P4: a flat chain of comparisons joined by `and`,
 * case-insensitive SCIM-style operator keywords (they map 1:1 onto core's
 * `Op` union), dotted attribute paths, and string/number/boolean literals.
 * No `or`, `not`, or parentheses/nesting -- see the P4 plan notes and the
 * Backlog section of docs/PROVISIONING_SERVICE_PLAN.md if a caller needs them.
 *
 * Grammar:
 *   filter  := clause (" and " clause)*
 *   clause  := path SP op [SP value]
 *   path    := ident ("." ident)*
 *   op      := "eq" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le" | "pr"
 *   value   := "\"" ... "\"" | number | "true" | "false"
 */
import type { Node, Op } from "@governance-connector-framework/core";
// `and`/`cmp` are values, but core's main entry re-exports filter/ast with
// `export type *`, so they are only importable as values from the subpath
// (same pattern already established in src/ops/Dispatcher.ts for `cmp`).
import { and, cmp } from "@governance-connector-framework/core/filter";

export class FilterSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterSyntaxError";
  }
}

const OP_KEYWORDS: Record<string, Op> = {
  eq: "EQ",
  co: "CONTAINS",
  sw: "STARTS_WITH",
  ew: "ENDS_WITH",
  gt: "GT",
  ge: "GTE",
  lt: "LT",
  le: "LTE",
  pr: "EXISTS",
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Split on whitespace, keeping a quoted string (with \" and \\ escapes) as one token. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function parseValue(token: string): string | number | boolean {
  if (token.startsWith("\"")) {
    if (!token.endsWith("\"") || token.length < 2) {
      throw new FilterSyntaxError(`unterminated string literal: ${token}`);
    }
    return token.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (token === "true") return true;
  if (token === "false") return false;
  const n = Number(token);
  if (Number.isNaN(n) || token === "") {
    throw new FilterSyntaxError(`expected a quoted string, number, or boolean, got: ${token}`);
  }
  return n;
}

/**
 * Parse a filter expression into core's `Node` AST.
 *
 * Throws {@link FilterSyntaxError} on anything outside the grammar above --
 * callers map that to a 400, matching `ValidationFailed` in `openapi.yaml`.
 */
export function parseFilterString(input: string): Node {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new FilterSyntaxError("filter must not be empty");
  }

  const tokens = tokenize(trimmed);
  const clauses: Node[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (i > 0) {
      const joiner = tokens[i];
      if (joiner?.toLowerCase() !== "and") {
        throw new FilterSyntaxError(
            `expected "and" between clauses, got: ${joiner ?? "<end>"} ` +
            `(or, not, and parentheses are not supported)`);
      }
      i += 1;
    }

    const pathToken = tokens[i];
    if (pathToken === undefined) throw new FilterSyntaxError("expected an attribute path");
    if (!IDENT_RE.test(pathToken)) {
      throw new FilterSyntaxError(`invalid attribute path: ${pathToken}`);
    }
    i += 1;

    const opToken = tokens[i];
    if (opToken === undefined) throw new FilterSyntaxError(`expected an operator after ${pathToken}`);
    const op = OP_KEYWORDS[opToken.toLowerCase()];
    if (!op) {
      throw new FilterSyntaxError(
          `unknown operator: ${opToken} (expected one of ${Object.keys(OP_KEYWORDS).join(", ")})`);
    }
    i += 1;

    const path = pathToken.split(".");

    if (op === "EXISTS") {
      clauses.push(cmp(op, path));
      continue;
    }

    const valueToken = tokens[i];
    if (valueToken === undefined) throw new FilterSyntaxError(`expected a value after ${opToken}`);
    i += 1;
    clauses.push(cmp(op, path, parseValue(valueToken)));
  }

  if (clauses.length === 0) throw new FilterSyntaxError("filter must have at least one clause");
  return clauses.length === 1 ? clauses[0]! : and(...clauses);
}
