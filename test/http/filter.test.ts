import { describe, it, expect } from "vitest";
import { parseFilterString, FilterSyntaxError } from "../../src/http/filter.js";

describe("parseFilterString", () => {
  it("parses a single eq comparison with a string value", () => {
    expect(parseFilterString('email eq "a@b.com"')).toEqual({
      type: "CMP", op: "EQ", path: ["email"], value: "a@b.com",
    });
  });

  it("parses every operator", () => {
    const cases: Array<[string, string]> = [
      ["co", "CONTAINS"], ["sw", "STARTS_WITH"], ["ew", "ENDS_WITH"],
      ["gt", "GT"], ["ge", "GTE"], ["lt", "LT"], ["le", "LTE"],
    ];
    for (const [kw, op] of cases) {
      expect(parseFilterString(`name ${kw} "x"`)).toMatchObject({ type: "CMP", op, path: ["name"] });
    }
  });

  it("is case-insensitive on the operator keyword", () => {
    expect(parseFilterString('name EQ "x"')).toMatchObject({ op: "EQ" });
  });

  it("parses pr with no value", () => {
    expect(parseFilterString("email pr")).toEqual({ type: "CMP", op: "EXISTS", path: ["email"] });
  });

  it("splits a dotted path into segments", () => {
    expect(parseFilterString('name.givenName eq "Alice"')).toMatchObject({
      path: ["name", "givenName"],
    });
  });

  it("parses a bare number value", () => {
    expect(parseFilterString("age gt 21")).toMatchObject({ value: 21 });
  });

  it("parses true/false as booleans, not strings", () => {
    expect(parseFilterString("active eq true")).toMatchObject({ value: true });
    expect(parseFilterString("active eq false")).toMatchObject({ value: false });
  });

  it("unescapes \\\" and \\\\ inside a quoted string", () => {
    expect(parseFilterString('note eq "say \\"hi\\" \\\\ done"')).toMatchObject({
      value: 'say "hi" \\ done',
    });
  });

  it("ANDs a flat chain of comparisons", () => {
    const node = parseFilterString('email eq "a@b.com" and active eq true');
    expect(node).toEqual({
      type: "AND",
      nodes: [
        { type: "CMP", op: "EQ", path: ["email"], value: "a@b.com" },
        { type: "CMP", op: "EQ", path: ["active"], value: true },
      ],
    });
  });

  it("rejects an empty filter", () => {
    expect(() => parseFilterString("")).toThrow(FilterSyntaxError);
    expect(() => parseFilterString("   ")).toThrow(FilterSyntaxError);
  });

  it("rejects or", () => {
    expect(() => parseFilterString('email eq "x" or active eq true')).toThrow(FilterSyntaxError);
  });

  it("rejects not", () => {
    expect(() => parseFilterString('not email eq "x"')).toThrow(FilterSyntaxError);
  });

  it("rejects parentheses", () => {
    expect(() => parseFilterString('(email eq "x")')).toThrow(FilterSyntaxError);
  });

  it("rejects an unknown operator", () => {
    expect(() => parseFilterString('email lol "x"')).toThrow(FilterSyntaxError);
  });

  it("rejects a clause missing its value", () => {
    expect(() => parseFilterString("email eq")).toThrow(FilterSyntaxError);
  });

  it("rejects an unterminated quoted string", () => {
    expect(() => parseFilterString('email eq "unterminated')).toThrow(FilterSyntaxError);
  });

  it("rejects a garbage value that isn't a string, number, or boolean", () => {
    expect(() => parseFilterString("age gt notanumber")).toThrow(FilterSyntaxError);
  });

  it("rejects an invalid attribute path", () => {
    expect(() => parseFilterString('123bad eq "x"')).toThrow(FilterSyntaxError);
  });
});
