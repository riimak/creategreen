import { assert, assertStringIncludes, assertThrows } from "jsr:@std/assert";

function isUrlQueryDelimiter(source: string, questionIndex: number): boolean {
  const lineStart = source.lastIndexOf("\n", questionIndex) + 1;
  const nextLine = source.indexOf("\n", questionIndex);
  const lineEnd = nextLine === -1 ? source.length : nextLine;

  let openingQuote = -1;
  for (const quote of ["'", '"', "`"]) {
    const candidate = source.lastIndexOf(quote, questionIndex - 1);
    const closingQuote = source.indexOf(quote, questionIndex + 1);
    if (
      candidate >= lineStart &&
      candidate > openingQuote &&
      closingQuote !== -1 &&
      closingQuote < lineEnd
    ) {
      openingQuote = candidate;
    }
  }

  return openingQuote >= 0 &&
    source.slice(openingQuote + 1, questionIndex).trimStart().startsWith("/") &&
    source.indexOf("?", openingQuote + 1) === questionIndex;
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

  const hrStart = dashboard.indexOf("  hr: {");
  const enStart = dashboard.indexOf("  en: {", hrStart);
  assert(hrStart >= 0, "Croatian translation block is missing");
  assert(enStart > hrStart, "English translation block is missing");

  const hrTranslations = dashboard.slice(hrStart, enStart);
  assert(
    !hrTranslations.includes("?"),
    "Croatian translation block contains literal question marks",
  );

  assertNoUnexpectedEmbeddedQuestionMarks(dashboard);
});

Deno.test("embedded question mark check only allows URL query delimiters", () => {
  assertNoUnexpectedEmbeddedQuestionMarks(
    "fetch(`/prediction/measurements?source=station`)",
  );
  assertThrows(() => assertNoUnexpectedEmbeddedQuestionMarks("'a?foo='"));
  assertThrows(() => assertNoUnexpectedEmbeddedQuestionMarks("`a?${value}`"));
  assertThrows(() =>
    assertNoUnexpectedEmbeddedQuestionMarks('"/api?key=a?foo"')
  );
});
