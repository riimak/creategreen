import { assert, assertNotMatch, assertStringIncludes } from "jsr:@std/assert";

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

  const renderedContent = dashboard.replaceAll(
    /\?(?=[A-Za-z][A-Za-z0-9_]*=|\$\{)/g,
    "",
  );
  assertNotMatch(
    renderedContent,
    /[\p{L}]\?[\p{L}]/u,
    "dashboard contains a question mark embedded in a rendered word",
  );
});
