import type { ReactNode } from "react";

/**
 * A code panel with light, deterministic highlighting.
 *
 * Tokens are turned into React nodes rather than an HTML string, so nothing here
 * can inject markup. The grammar is intentionally tiny — comments, strings,
 * numbers, and a fixed keyword list — because a site does not need a real
 * parser and a half-real one is just a source of wrong colours.
 */

const KEYWORDS = new Set([
  "const",
  "let",
  "await",
  "async",
  "import",
  "from",
  "export",
  "return",
  "function",
  "new",
  "throw",
  "try",
  "catch",
  "if",
  "else",
  "true",
  "false",
  "null",
  "undefined",
]);

const TOKEN_PATTERN =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function highlight(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of code.matchAll(TOKEN_PATTERN)) {
    const [text, comment, string, numeric, word] = match;
    const start = match.index;

    if (start > lastIndex) nodes.push(code.slice(lastIndex, start));
    lastIndex = start + text.length;

    if (comment !== undefined) {
      nodes.push(
        <span className="tok-com" key={key++}>
          {text}
        </span>
      );
    } else if (string !== undefined) {
      nodes.push(
        <span className="tok-str" key={key++}>
          {text}
        </span>
      );
    } else if (numeric !== undefined) {
      nodes.push(
        <span className="tok-num" key={key++}>
          {text}
        </span>
      );
    } else if (word !== undefined && KEYWORDS.has(word)) {
      nodes.push(
        <span className="tok-key" key={key++}>
          {text}
        </span>
      );
    } else {
      nodes.push(text);
    }
  }

  if (lastIndex < code.length) nodes.push(code.slice(lastIndex));
  return nodes;
}

export function CodePanel({
  filename,
  label,
  code,
  plain = false,
}: {
  filename: string;
  label?: string;
  code: string;
  /** Skip highlighting, for shell commands and output. */
  plain?: boolean;
}) {
  return (
    <div className="code-panel">
      <div className="code-panel__tab">
        <span>{filename}</span>
        {label === undefined ? null : <span>{label}</span>}
      </div>
      <pre>
        <code>{plain ? code : highlight(code)}</code>
      </pre>
    </div>
  );
}
