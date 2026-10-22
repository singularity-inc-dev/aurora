/**
 * A stand-in for GitHub, for tests only. Serves a real bare git repository over
 * smart HTTP (git http-backend) and the few REST calls the email service makes
 * (list/open/get/merge pull requests). Every request must carry the token.
 * Branch protection can be switched on: merges then answer 405 like GitHub.
 *
 * Run standalone: node tests/fake-github.ts <port> <dir> <owner/name> <token-file>
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";

export interface FakePull {
  number: number;
  title: string;
  head: string;
  base: string;
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
}

export interface FakeGithub {
  server: Server;
  repoDir: string;
  pulls: FakePull[];
  /** Every request: what it asked for and whether it carried the right token. */
  requests: Array<{ method: string; path: string; authorized: boolean }>;
  protection: boolean;
  git(...args: string[]): string;
}

const ID = ["-c", "user.name=Reviewer", "-c", "user.email=reviewer@example.com"];

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function createFakeGithub(opts: { dir: string; repo: string; token: string }): FakeGithub {
  const repoDir = path.join(opts.dir, `${opts.repo}.git`);
  mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: opts.dir } });
  git("init", "-q", "--bare", "-b", "main");
  git("config", "http.receivepack", "true");
  const basic = `Basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
  const state: FakeGithub = { server: null as unknown as Server, repoDir, pulls: [], requests: [], protection: false, git };

  const squash = (pr: FakePull): string => {
    const base = git("rev-parse", `refs/heads/${pr.base}`).trim();
    const tree = git("merge-tree", "--write-tree", base, pr.headSha).split("\n")[0]!.trim();
    const commit = execFileSync("git", [...ID, "commit-tree", tree, "-p", base, "-m", `${pr.title} (#${pr.number})`], { cwd: repoDir, encoding: "utf8" }).trim();
    git("update-ref", `refs/heads/${pr.base}`, commit, base);
    pr.state = "closed";
    pr.merged = true;
    pr.mergeSha = commit;
    return commit;
  };

  state.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    // Test controls (a reviewer acting on GitHub, or the owner changing protection).
    if (url.pathname.startsWith("/__control/")) {
      const [, , what, n] = url.pathname.split("/");
      const pr = state.pulls.find((p) => p.number === Number(n));
      if (what === "protection") state.protection = url.searchParams.get("on") === "1";
      else if (what === "merge" && pr) squash(pr);
      else if (what === "close" && pr) pr.state = "closed";
      else if (what === "push-other") {
        // Someone else pushes to the base branch on GitHub.
        const base = git("rev-parse", "refs/heads/main").trim();
        const tree = git("rev-parse", `${base}^{tree}`).trim();
        git("update-ref", "refs/heads/main", execFileSync("git", [...ID, "commit-tree", tree, "-p", base, "-m", "other work"], { cwd: repoDir, encoding: "utf8" }).trim(), base);
      }
      return json(200, { protection: state.protection, pulls: state.pulls, requests: state.requests });
    }

    if (url.pathname.startsWith("/api/")) {
      const authorized = req.headers.authorization === `Bearer ${opts.token}`;
      state.requests.push({ method: req.method ?? "", path: url.pathname, authorized });
      if (!authorized) return json(401, { message: "Bad credentials" });
      const m = /^\/api\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?(\/merge)?$/.exec(url.pathname);
      if (!m || m[1] !== opts.repo) return json(404, { message: "Not Found" });
      const pr = m[2] ? state.pulls.find((p) => p.number === Number(m[2])) : undefined;
      const view = (p: FakePull) => ({
        number: p.number,
        html_url: `https://github.example/${opts.repo}/pull/${p.number}`,
        state: p.state,
        merged: p.merged,
        mergeable: true,
        merge_commit_sha: p.mergeSha,
        head: { ref: p.head, sha: p.headSha },
        base: { ref: p.base },
      });
      if (req.method === "GET" && !m[2]) {
        const head = url.searchParams.get("head")?.split(":")[1];
        return json(200, state.pulls.filter((p) => p.state === "open" && (!head || p.head === head)).map(view));
      }
      if (req.method === "POST" && !m[2]) {
        const b = JSON.parse((await body(req)).toString() || "{}");
        let headSha: string;
        try {
          headSha = git("rev-parse", `refs/heads/${b.head}`).trim();
        } catch {
          return json(422, { message: "Validation Failed: head branch not found" });
        }
        if (state.pulls.some((p) => p.state === "open" && p.head === b.head)) return json(422, { message: "A pull request already exists" });
        const p: FakePull = { number: state.pulls.length + 1, title: b.title, head: b.head, base: b.base, headSha, state: "open", merged: false, mergeSha: null };
        state.pulls.push(p);
        return json(201, view(p));
      }
      if (!pr) return json(404, { message: "Not Found" });
      if (req.method === "GET") return json(200, view(pr));
      if (req.method === "PUT" && m[3]) {
        const b = JSON.parse((await body(req)).toString() || "{}");
        pr.headSha = git("rev-parse", `refs/heads/${pr.head}`).trim();
        if (pr.state !== "open") return json(405, { message: "Pull Request is not mergeable" });
        if (b.sha && b.sha !== pr.headSha) return json(409, { message: "Head branch was modified. Review and try the merge again." });
        if (b.merge_method !== "squash") return json(405, { message: "Only squash merges are allowed" });
        if (state.protection) return json(405, { message: "At least 1 approving review is required by reviewers with write access." });
        return json(200, { merged: true, sha: squash(pr), message: "Pull Request successfully merged" });
      }
      return json(404, { message: "Not Found" });
    }

    // git over smart HTTP, through the real git http-backend.
    const authorized = req.headers.authorization === basic;
    state.requests.push({ method: req.method ?? "", path: url.pathname, authorized });
    if (!authorized) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
      return res.end();
    }
    const input = await body(req);
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: opts.dir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(input.length),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    cgi.stdout.on("data", (c) => out.push(c));
    cgi.stdin.end(input);
    cgi.on("close", () => {
      const all = Buffer.concat(out);
      let split = all.indexOf("\r\n\r\n");
      let sep = 4;
      if (split < 0) {
        split = all.indexOf("\n\n");
        sep = 2;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of all.subarray(0, split).toString().split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(all.subarray(split + sep));
    });
  });
  return state;
}

/** Seed the fake GitHub repo from a local repository's branch (e.g. its main). */
export function seedFrom(fake: FakeGithub, localRepo: string, branch = "main"): void {
  execFileSync("git", ["-c", "push.negotiate=false", "push", "-q", fake.repoDir, `${branch}:refs/heads/${branch}`], { cwd: localRepo });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [port, dir, repo, tokenFile] = process.argv.slice(2);
  const fake = createFakeGithub({ dir: dir!, repo: repo!, token: readFileSync(tokenFile!, "utf8").trim() });
  fake.server.listen(Number(port), "127.0.0.1", () => {
    writeFileSync(path.join(dir!, "ready"), "ok");
    console.log(`fake GitHub on http://127.0.0.1:${port} serving ${repo}`);
  });
}
