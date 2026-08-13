# Dashboard UTF-8 Repair Design

## Problem

The dashboard branding update in commit `cd5b56d` replaced Unicode characters
in `dashboard/index.html` with literal question marks. This affects Croatian
diacritics, punctuation, arrows, mathematical symbols, and technical symbols
throughout all dashboard tabs.

## Scope

- Restore every corrupted character whose correct value exists in the parent
  revision of `cd5b56d`.
- Preserve legitimate branding, logo, navigation, layout, and copy changes
  introduced by that commit and later work.
- Keep `index.html` encoded as UTF-8 without a byte-order mark.
- Add an automated regression test that checks representative Croatian
  diacritics and rejects known corruption markers in user-facing strings.

## Approach

Use the valid pre-corruption file as the character source and compare it with
the current file line by line. Apply only character-level restorations where
the surrounding text still identifies the same content. Review lines changed
structurally by the branding update manually so valid newer markup remains.

The repair includes Croatian letters (`č`, `ć`, `đ`, `š`, `ž` and uppercase
forms), typographic punctuation, arrows, multiplication signs, approximation
signs, and other symbols that were converted to `?`.

## Verification

1. The regression test fails against the current corrupted file.
2. The test passes after repair.
3. Existing dashboard tests pass in Docker through WSL.
4. A repository search finds no known corruption markers in rendered copy.
5. The production dashboard is visually checked in Croatian after deployment.

## Non-goals

- No visual redesign or copy rewrite.
- No changes to dashboard data, APIs, or translation architecture.
- No unrelated cleanup of the single-file dashboard.
