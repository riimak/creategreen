import { assert, assertStringIncludes, assertThrows } from "jsr:@std/assert";

function isUrlQueryDelimiter(source: string, questionIndex: number): boolean {
  const lineStart = source.lastIndexOf("\n", questionIndex) + 1;
  const nextLine = source.indexOf("\n", questionIndex);
  const lineEnd = nextLine === -1 ? source.length : nextLine;
  const line = source.slice(lineStart, lineEnd);
  const relativeQuestionIndex = questionIndex - lineStart;

  let quote: "'" | '"' | "`" | undefined;
  let openingQuote = -1;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote === undefined) {
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        openingQuote = index;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      if (
        openingQuote < relativeQuestionIndex && relativeQuestionIndex < index
      ) {
        const contentStart = openingQuote + 1;
        return line.slice(contentStart, relativeQuestionIndex).trimStart()
          .startsWith("/") &&
          line.indexOf("?", contentStart) === relativeQuestionIndex;
      }
      quote = undefined;
      openingQuote = -1;
    }
  }

  return false;
}

function assertNoUnexpectedEmbeddedQuestionMarks(source: string): void {
  const suspiciousPatterns = [
    /[\p{L}]\?[\p{L}]/gu,
    /[\p{L}]\?\$\{/gu,
  ];

  for (const pattern of suspiciousPatterns) {
    for (const match of source.matchAll(pattern)) {
      const questionIndex = match.index + match[0].indexOf("?");
      assert(
        isUrlQueryDelimiter(source, questionIndex),
        `unexpected embedded question mark near ${
          JSON.stringify(source.slice(questionIndex - 30, questionIndex + 31))
        }`,
      );
    }
  }
}

const dashboard = await Deno.readTextFile(
  new URL("./index.html", import.meta.url),
);

Deno.test("dashboard preserves Croatian text and rendered Unicode", () => {
  for (
    const text of [
      "uživo",
      "ažurirano",
      "Vlažnost",
      "Sunčevo zračenje",
      "Mreža",
      "izračunato",
      "ograničen",
    ]
  ) {
    assertStringIncludes(dashboard, text);
  }

  assertNoUnexpectedEmbeddedQuestionMarks(dashboard);
});

Deno.test("translation dictionaries reject question-mark corruption", () => {
  const hrStart = dashboard.indexOf("  hr: {");
  const enStart = dashboard.indexOf("  en: {", hrStart);
  const enEnd = dashboard.indexOf("\n};", enStart);
  assert(hrStart >= 0, "Croatian translation block is missing");
  assert(enStart > hrStart, "English translation block is missing");
  assert(enEnd > enStart, "English translation block end is missing");

  const hrTranslations = dashboard.slice(hrStart, enStart);
  const enTranslations = dashboard.slice(enStart, enEnd);
  assert(
    !hrTranslations.includes("?"),
    "Croatian translation block contains literal question marks",
  );
  for (
    const [language, translations] of [
      ["Croatian", hrTranslations],
      ["English", enTranslations],
    ]
  ) {
    assert(
      !translations.includes(" ? "),
      `${language} translation block contains spaced question-mark corruption`,
    );
  }
});

Deno.test("embedded question mark check only allows URL query delimiters", () => {
  assertNoUnexpectedEmbeddedQuestionMarks(
    "fetch(`/prediction/measurements?source=station`)",
  );
  assertNoUnexpectedEmbeddedQuestionMarks(
    'fetch("/api/\\"quoted\\"?key=value")',
  );
  assertThrows(() => assertNoUnexpectedEmbeddedQuestionMarks("'a?foo='"));
  assertThrows(() => assertNoUnexpectedEmbeddedQuestionMarks("`a?${value}`"));
  assertThrows(() =>
    assertNoUnexpectedEmbeddedQuestionMarks('"/api?key=a?foo"')
  );
  assertThrows(() =>
    assertNoUnexpectedEmbeddedQuestionMarks(
      '<div title="done"/><span>a?foo</span><div title="x">',
    )
  );
});
