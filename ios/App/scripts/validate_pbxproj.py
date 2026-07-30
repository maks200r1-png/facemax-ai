#!/usr/bin/env python3
"""
validate_pbxproj.py — minimal OpenStep-plist structural validator.

project.pbxproj is NOT XML/binary plist (which Python's plistlib handles);
it's the old NeXT/OpenStep ASCII plist format: `{ key = value; }`,
`( a, b, c )`, bare/quoted strings, and `/* comments */` that are skippable
whitespace.

This is not a full parser (it doesn't construct a Python object graph,
just verifies the token stream is well-formed), but it's enough to catch
the class of bug that a "does the file contain string X" check cannot:
a value sitting outside any enclosing {} or () that it should be inside.

Exit code 0 = structurally valid. Non-zero = parse error, with position info.
"""
import sys
import re


class ParseError(Exception):
    pass


class Lexer:
    TOKEN_RE = re.compile(r"""
        \s+                                  # whitespace
      | /\*.*?\*/                             # block comment
      | //[^\n]*                              # line comment (e.g. // !$*UTF8*$!)
      | "(?:[^"\\]|\\.)*"                     # quoted string
      | [A-Za-z0-9_./\$]+                     # bare identifier
      | [{}();=,]                             # punctuation
    """, re.VERBOSE | re.DOTALL)

    def __init__(self, text):
        self.text = text
        self.tokens = []
        pos = 0
        while pos < len(text):
            m = self.TOKEN_RE.match(text, pos)
            if not m:
                line = text.count("\n", 0, pos) + 1
                raise ParseError(f"Unrecognized character at byte {pos} (line {line}): {text[pos:pos+40]!r}")
            tok = m.group(0)
            if not tok.isspace() and not tok.startswith("/*") and not tok.startswith("//"):
                self.tokens.append((tok, pos))
            pos = m.end()

    def __iter__(self):
        return iter(self.tokens)


def parse(tokens, i):
    """Parse a value starting at tokens[i]. Returns next index after the value."""
    if i >= len(tokens):
        raise ParseError("Unexpected end of input while expecting a value")
    tok, pos = tokens[i]

    if tok == "{":
        i += 1
        while True:
            if i >= len(tokens):
                raise ParseError(f"Unterminated dictionary (started near byte {pos})")
            tok, pos2 = tokens[i]
            if tok == "}":
                return i + 1
            # expect: KEY = VALUE ;
            key_tok, key_pos = tokens[i]
            if key_tok in ("{", "(", "}", ")", "=", ";", ","):
                raise ParseError(f"Expected a dictionary key at byte {key_pos}, found bare token {key_tok!r} "
                                  f"(this is the bug class where a list entry leaks outside its enclosing list)")
            i += 1
            if i >= len(tokens) or tokens[i][0] != "=":
                got = tokens[i][0] if i < len(tokens) else "<eof>"
                raise ParseError(f"Expected '=' after key {key_tok!r} at byte {key_pos}, found {got!r}")
            i += 1  # consume '='
            i = parse(tokens, i)  # value
            if i >= len(tokens) or tokens[i][0] != ";":
                got = tokens[i][0] if i < len(tokens) else "<eof>"
                raise ParseError(f"Expected ';' after value for key {key_tok!r}, found {got!r}")
            i += 1  # consume ';'

    elif tok == "(":
        i += 1
        while True:
            if i >= len(tokens):
                raise ParseError(f"Unterminated array (started near byte {pos})")
            tok2, pos2 = tokens[i]
            if tok2 == ")":
                return i + 1
            i = parse(tokens, i)  # element
            if i < len(tokens) and tokens[i][0] == ",":
                i += 1
            elif i < len(tokens) and tokens[i][0] == ")":
                continue
            else:
                got = tokens[i][0] if i < len(tokens) else "<eof>"
                raise ParseError(f"Expected ',' or ')' in array after element, found {got!r} at byte {pos2}")

    elif tok in ("{", "}", "(", ")", "=", ";", ","):
        raise ParseError(f"Unexpected punctuation {tok!r} at byte {pos} while expecting a value")

    else:
        # bare identifier or quoted string — a scalar value
        return i + 1


def validate_text(text: str) -> None:
    """Raise ParseError if `text` is not a structurally valid OpenStep plist."""
    lexer = Lexer(text)
    tokens = lexer.tokens
    if not tokens:
        raise ParseError("Empty file")
    end = parse(tokens, 0)
    if end != len(tokens):
        extra_tok, extra_pos = tokens[end]
        raise ParseError(f"Trailing tokens after top-level value, starting with {extra_tok!r} at byte {extra_pos}")


def main():
    if len(sys.argv) != 2:
        print("usage: validate_pbxproj.py <path-to-project.pbxproj>")
        sys.exit(2)

    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    try:
        validate_text(text)
    except ParseError as e:
        print(f"INVALID: {e}")
        sys.exit(1)

    print("VALID: project.pbxproj is structurally well-formed OpenStep plist")
    sys.exit(0)


if __name__ == "__main__":
    main()
