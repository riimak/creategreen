# Dashboard UTF-8 Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore all dashboard characters corrupted to literal question marks while preserving the current branding and layout.

**Architecture:** Add a source-level regression test around the existing single-file dashboard, then perform a mechanical character-only restoration using the valid parent of commit `cd5b56d` as the reference. Review unmatched lines manually and keep the current file structure unchanged.

**Tech Stack:** Deno tests, HTML/CSS/JavaScript, Python 3.13 `difflib` in a disposable Docker container, Git.

## Global Constraints

- Run all tests and repair tooling through Docker from WSL.
- Preserve current branding, logo, navigation, layout, and copy changes.
- Keep `index.html` as UTF-8 without a byte-order mark.
- Do not redesign or rewrite dashboard copy.

---

### Task 1: Restore dashboard UTF-8 text and prevent regression

**Files:**
- Create: `bios-multilevel-platform-services/dashboard/utf8_test.ts`
- Modify: `bios-multilevel-platform-services/dashboard/index.html`
- Temporary: `.superpowers/restore-dashboard-utf8.py` (delete before commit)

**Interfaces:**
- Consumes: the valid `index.html` from `cd5b56d^` and the current dashboard file.
- Produces: UTF-8 dashboard copy with Croatian diacritics and symbols restored; a Deno regression test.

- [ ] **Step 1: Write the failing source-level test**

Create `utf8_test.ts`:

```typescript
import { assert, assertStringIncludes } from "jsr:@std/assert";

const html = await Deno.readTextFile(
  new URL("./index.html", import.meta.url),
);

Deno.test("Croatian dashboard copy preserves UTF-8 diacritics", () => {
  for (const expected of [
    "uživo",
    "ažurirano",
    "Vlažnost",
    "Sunčevo zračenje",
    "Mreža",
    "izračunato",
    "ograničen",
  ]) {
    assertStringIncludes(html, expected);
  }

  const hrStart = html.indexOf("  hr: {");
  const enStart = html.indexOf("  en: {", hrStart);
  assert(hrStart >= 0 && enStart > hrStart);
  const croatianDictionary = html.slice(hrStart, enStart);
  assert(
    !croatianDictionary.includes("?"),
    "Croatian translations contain a replacement question mark",
  );
});

Deno.test("rendered words contain no replacement question marks", () => {
  assert(
    !/[\p{L}]\?[\p{L}]/u.test(html),
    "dashboard contains a question mark inside a rendered word",
  );
});
```

- [ ] **Step 2: Run the test and verify the existing corruption is detected**

Run:

```powershell
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && docker run --rm -v "$PWD:/workspace:ro" -w /workspace/bios-multilevel-platform-services/dashboard denoland/deno:2.4.2 test --allow-read utf8_test.ts'
```

Expected: FAIL for missing `uživo` or for a question mark in the Croatian dictionary.

- [ ] **Step 3: Mechanically restore matching corrupted lines**

Create `.superpowers/restore-dashboard-utf8.py`:

```python
from pathlib import Path
import subprocess

path = Path("bios-multilevel-platform-services/dashboard/index.html")
git_path = path.as_posix()
old = subprocess.check_output(
    ["git", "show", f"cd5b56d^:{git_path}"],
    text=True,
    encoding="utf-8-sig",
)
current = path.read_text(encoding="utf-8")

def degraded(line: str) -> str:
    return "".join(char if ord(char) < 128 else "?" for char in line)

reference = {}
ambiguous = set()
for line in old.splitlines(keepends=True):
    key = degraded(line)
    if key in reference and reference[key] != line:
        ambiguous.add(key)
    else:
        reference[key] = line

for key in ambiguous:
    reference.pop(key, None)

restored = []
for line in current.splitlines(keepends=True):
    candidate = reference.get(line)
    restored.append(candidate if candidate is not None else line)

path.write_text("".join(restored), encoding="utf-8", newline="\n")
```

Run:

```powershell
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && docker run --rm -v "$PWD:/workspace" -w /workspace python:3.13-alpine sh -lc "apk add --no-cache git >/dev/null && python .superpowers/restore-dashboard-utf8.py"'
```

- [ ] **Step 4: Repair unmatched rendered strings and review the diff**

Use the pre-corruption revision to restore any remaining user-facing strings
reported by `utf8_test.ts`. Preserve lines whose markup or copy legitimately
changed in `cd5b56d`. Confirm the final diff changes only corrupted characters
and adds the test.

- [ ] **Step 5: Run focused and existing dashboard tests**

Run:

```powershell
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && docker run --rm -v "$PWD:/workspace:ro" -w /workspace/bios-multilevel-platform-services/dashboard denoland/deno:2.4.2 test --allow-read --allow-env --allow-net'
```

Expected: all dashboard tests pass.

- [ ] **Step 6: Remove temporary tooling and commit**

Delete `.superpowers/restore-dashboard-utf8.py`, verify the worktree contains
only `index.html` and `utf8_test.ts`, then commit:

```powershell
git add bios-multilevel-platform-services/dashboard/index.html bios-multilevel-platform-services/dashboard/utf8_test.ts
git commit -m "fix: restore dashboard UTF-8 text"
```

- [ ] **Step 7: Deploy and verify**

Push the reviewed commit to `barrage/production`. Confirm the dashboard pod is
ready and verify representative Croatian labels render as `uživo`, `Mreža`,
`Vlažnost`, `Sunčevo zračenje`, and `izračunato`.
