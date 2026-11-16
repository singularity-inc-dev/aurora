import { describe, expect, it } from "vitest";
import { areaOwners, claimsOverlap, codeownersPattern, covers, normalizeClaim, ownerNames, parseCodeowners } from "../src/claims.js";

describe("claims", () => {
  it("are stored without leading or trailing slashes", () => {
    expect(normalizeClaim(" /src/ui/ ")).toBe("src/ui");
    expect(normalizeClaim("src/**/*.ts")).toBe("src/**/*.ts");
  });

  it("refuses what it cannot read safely", () => {
    for (const bad of ["", "/", "../secrets", "src/../x", "src//x", "./src", "src\\ui", "src/[ab].ts", "!src", 42, null, "x".repeat(201)]) {
      expect(normalizeClaim(bad)).toBeNull();
    }
  });

  it("a file the repository has holds nothing below it", () => {
    expect(claimsOverlap("**/*.sql", "src/a.ts")).toBe(true);
    expect(claimsOverlap("**/*.sql", "src/a.ts", { bIsFile: true })).toBe(false);
    expect(claimsOverlap("src/a.ts", "src/a.ts", { aIsFile: true, bIsFile: true })).toBe(true);
  });

  it("a folder overlaps the files inside it, and siblings do not overlap", () => {
    expect(claimsOverlap("src/ui", "src/ui/button.tsx")).toBe(true);
    expect(claimsOverlap("src/ui/button.tsx", "src/ui")).toBe(true);
    expect(claimsOverlap("src/ui", "src/api")).toBe(false);
    expect(claimsOverlap("src/ui", "src/uix")).toBe(false);
    expect(claimsOverlap("README.md", "README.md")).toBe(true);
  });

  it("understands *, ? and **", () => {
    expect(claimsOverlap("src/*.ts", "src/index.ts")).toBe(true);
    expect(claimsOverlap("src/*.ts", "src/index.js")).toBe(false);
    expect(claimsOverlap("**/*.sql", "db/migrations/001.sql")).toBe(true);
    expect(claimsOverlap("src/**/test.ts", "src/a/b/test.ts")).toBe(true);
    expect(claimsOverlap("src/**/test.ts", "lib/a/test.ts")).toBe(false);
    expect(claimsOverlap("v?.json", "v1.json")).toBe(true);
    expect(claimsOverlap("**", "anything/at/all")).toBe(true);
  });

  it("errs on the side of an overlap when both sides have wildcards", () => {
    expect(claimsOverlap("src/*.ts", "src/a*")).toBe(true);
  });

  it("covers only when plainly so", () => {
    expect(covers("src/ui", "src/ui/button.tsx")).toBe(true);
    expect(covers("src/ui", "src/ui/**/*.css")).toBe(true);
    expect(covers("src/ui", "src")).toBe(false);
    expect(covers("**/*.css", "src/ui/a.css")).toBe(false);
    expect(covers("**", "src")).toBe(true);
    expect(covers("**/docs", "site/docs/guide.md")).toBe(true);
    expect(covers("**/docs", "docs")).toBe(true);
    expect(covers("**/docs", "site")).toBe(false);
  });
});

describe("CODEOWNERS", () => {
  const file = [
    "# Owners",
    "*            @lead",
    "/src/ui/     @ana   # the UI",
    "src/api/     bo@example.com",
    "*.sql        @bo @cy",
    "docs/        ",
    "src/[x].ts   @nobody",
  ].join("\n");
  const { rules, skipped } = parseCodeowners(file);

  it("reads patterns the way GitHub does", () => {
    expect(codeownersPattern("/src/ui/")).toBe("src/ui");
    expect(codeownersPattern("src/api/")).toBe("src/api");
    expect(codeownersPattern("*.sql")).toBe("**/*.sql");
    expect(codeownersPattern("docs/")).toBe("**/docs");
    expect(rules.map((r) => [r.pattern, r.owners])).toEqual([
      ["**", ["@lead"]],
      ["src/ui", ["@ana"]],
      ["src/api", ["bo@example.com"]],
      ["**/*.sql", ["@bo", "@cy"]],
      ["**/docs", []],
    ]);
  });

  it("lists lines it cannot read instead of guessing", () => {
    expect(skipped).toEqual([7]);
  });

  it("the last matching rule wins for whatever it fully covers", () => {
    expect(areaOwners(rules, "src/ui/button.tsx", true)).toEqual(["@ana"]);
    // Not known to be a file: it might be a folder holding .sql files.
    expect(areaOwners(rules, "src/ui/button.tsx").sort()).toEqual(["@ana", "@bo", "@cy"]);
    expect(areaOwners(rules, "src/api/search.ts", true)).toEqual(["bo@example.com"]);
    // The folder also holds .sql files, which the later *.sql rule gives to @bo and @cy.
    expect(areaOwners(rules, "src/api").sort()).toEqual(["@bo", "@cy", "bo@example.com"]);
  });

  it("a wide claim reaches every area it touches", () => {
    expect(areaOwners(rules, "src").sort()).toEqual(["@ana", "@bo", "@cy", "@lead", "bo@example.com"].sort());
    expect(areaOwners(rules, "src/ui/schema.sql").sort()).toEqual(["@ana", "@bo", "@cy"].sort());
  });

  it("an area with no owners belongs to nobody", () => {
    expect(areaOwners(rules, "docs/guide.md")).toEqual([]);
  });

  it("matches owners by email or GitHub login, ignoring case", () => {
    const ana = { email: "Ana@Example.com", githubLogin: "ana-dev" };
    expect(ownerNames("ana@example.com", ana)).toBe(true);
    expect(ownerNames("@Ana-Dev", ana)).toBe(true);
    expect(ownerNames("@ana", ana)).toBe(false);
    expect(ownerNames("@ana", { email: "ana@example.com" })).toBe(false);
  });
});
