import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesGlob, normalizeGlob, splitGlobList } from "../src/glob.ts";

describe("splitGlobList", () => {
	it("splits on commas outside braces", () => {
		assert.deepEqual(splitGlobList("a/**/*.java, b/**/*.java"), ["a/**/*.java", "b/**/*.java"]);
	});
	it("keeps commas inside braces together", () => {
		assert.deepEqual(splitGlobList("{a,b}/src/**/*.java,c/**/*.java"), ["{a,b}/src/**/*.java", "c/**/*.java"]);
	});
	it("drops empty entries", () => {
		assert.deepEqual(splitGlobList(" , a ,, "), ["a"]);
	});
});

describe("normalizeGlob", () => {
	it("prefixes bare file patterns with **/", () => {
		assert.equal(normalizeGlob("*.ts"), "**/*.ts");
	});
	it("strips leading ./ and /", () => {
		assert.equal(normalizeGlob("./src/**"), "src/**");
		assert.equal(normalizeGlob("/src/**"), "src/**");
	});
	it("treats a trailing slash as the whole directory", () => {
		assert.equal(normalizeGlob("src/"), "src/**");
	});
});

describe("matchesGlob", () => {
	it("matches nested files through **", () => {
		assert.ok(matchesGlob("connect-backend/src/main/java/a/b/Foo.java", "connect-backend/src/main/**/*.java"));
		assert.ok(matchesGlob("connect-backend/src/main/Foo.java", "connect-backend/src/main/**/*.java"));
		assert.ok(!matchesGlob("connect-backend/src/test/java/FooTest.java", "connect-backend/src/main/**/*.java"));
	});
	it("matches brace alternatives", () => {
		assert.ok(matchesGlob("connect-portal/src/a/b.tsx", "connect-portal/src/**/*.{ts,tsx}"));
		assert.ok(matchesGlob("connect-portal/src/a/b.ts", "connect-portal/src/**/*.{ts,tsx}"));
		assert.ok(!matchesGlob("connect-portal/src/a/b.scss", "connect-portal/src/**/*.{ts,tsx}"));
	});
	it("matches brace alternatives at the start of a pattern", () => {
		const pattern = "{connect-backend,panel-event-processor}/src/main/**/*.java";
		assert.ok(matchesGlob("panel-event-processor/src/main/java/X.java", pattern));
		assert.ok(!matchesGlob("fake-panel/src/main/java/X.java", pattern));
	});
	it("matches everything with **", () => {
		assert.ok(matchesGlob("README.md", "**"));
		assert.ok(matchesGlob("a/b/c.txt", "**"));
	});
	it("matches a whole directory subtree with dir/**", () => {
		assert.ok(matchesGlob(".github/workflows/ci.yaml", ".github/workflows/**"));
		assert.ok(matchesGlob(".github/workflows/a/b.yaml", ".github/workflows/**"));
		assert.ok(!matchesGlob(".github/dependabot.yml", ".github/workflows/**"));
	});
	it("matches bare extension patterns anywhere in the tree", () => {
		assert.ok(matchesGlob("deep/dir/login.feature", "**/*.feature"));
		assert.ok(matchesGlob("login.feature", "**/*.feature"));
		assert.ok(matchesGlob("deep/dir/login.feature", "*.feature"));
	});
	it("matches suffix patterns inside a name", () => {
		assert.ok(matchesGlob("connect-backend/src/main/x/UserQueryService.java", "connect-backend/src/main/**/*QueryService.java"));
		assert.ok(!matchesGlob("connect-backend/src/main/x/UserService.java", "connect-backend/src/main/**/*QueryService.java"));
	});
	it("matches dockerfile patterns with braces and trailing wildcards", () => {
		assert.ok(matchesGlob("connect-backend/dockerfiles/deploy/Dockerfile", "**/dockerfiles/{deploy,dev}/Dockerfile*"));
		assert.ok(matchesGlob("x/dockerfiles/dev/Dockerfile.local", "**/dockerfiles/{deploy,dev}/Dockerfile*"));
		assert.ok(!matchesGlob("x/dockerfiles/prod/Dockerfile", "**/dockerfiles/{deploy,dev}/Dockerfile*"));
	});
	it("does not let * cross directory boundaries", () => {
		assert.ok(!matchesGlob("src/a/b.ts", "src/*.ts"));
		assert.ok(matchesGlob("src/b.ts", "src/*.ts"));
	});
	it("supports ? and character classes", () => {
		assert.ok(matchesGlob("V1__init.sql", "V?__*.sql"));
		assert.ok(matchesGlob("file1.txt", "file[0-9].txt"));
		assert.ok(!matchesGlob("fileA.txt", "file[0-9].txt"));
		assert.ok(matchesGlob("fileA.txt", "file[!0-9].txt"));
	});
	it("escapes regex specials in literal path parts", () => {
		assert.ok(matchesGlob("a.b/c+d.ts", "a.b/c+d.ts"));
		assert.ok(!matchesGlob("aXb/c+d.ts", "a.b/c+d.ts"));
	});
	it("matches exact file paths", () => {
		assert.ok(matchesGlob(".github/workflows/deploy-panel-connect.yaml", ".github/workflows/deploy-panel-connect.yaml"));
	});
});
