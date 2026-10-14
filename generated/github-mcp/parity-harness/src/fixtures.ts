// Throwaway-repo lifecycle. Uses gh CLI for setup/teardown to avoid bootstrapping problems.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Fixtures } from "./operations.js";

const exec = promisify(execFile);

async function gh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`gh ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

export async function setupFixtures(opts: {
  owner: string;
  publicOwner: string;
  publicRepo: string;
  testOrg: string;
}): Promise<Fixtures> {
  const ts = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const testRepo = `mcpaql-parity-test-${ts}`;

  const f: Fixtures = {
    owner: opts.owner,
    testRepo,
    publicOwner: opts.publicOwner,
    publicRepo: opts.publicRepo,
    testOrg: opts.testOrg,
    defaultBranch: "main",
    branchOfficial: "test-branch-official",
    branchMcpaql: "test-branch-mcpaql",
    forkPublicTarget: { owner: opts.publicOwner, repo: opts.publicRepo },
    // Public targets for 89-op coverage
    publicDiscussionsOwner: "vercel",
    publicDiscussionsRepo: "next.js",
    workflowOwner: "cli",
    workflowRepo: "cli",
    knownGhsaId: "GHSA-mxmp-wr3w-rvqx", // first published advisory returned by /advisories
  };

  console.log(`[setup] creating ${opts.owner}/${testRepo}...`);
  await gh([
    "repo", "create", `${opts.owner}/${testRepo}`,
    "--public", "--description", "MCPAQL parity test (auto-deleted)",
    "--add-readme",
  ]);

  // Wait for README to be available
  await new Promise((r) => setTimeout(r, 2000));

  // Create issues (paired) — these will be referenced by add_issue_comment, issue_write, sub_issue_write parents
  console.log(`[setup] creating issues...`);
  const i1 = await gh([
    "api", `/repos/${opts.owner}/${testRepo}/issues`,
    "-X", "POST", "-f", "title=Parity test issue (official channel)",
    "-f", "body=fixture for official-channel paired tests",
  ]);
  f.issueNumOfficial = JSON.parse(i1.stdout).number;
  const i2 = await gh([
    "api", `/repos/${opts.owner}/${testRepo}/issues`,
    "-X", "POST", "-f", "title=Parity test issue (mcpaql channel)",
    "-f", "body=fixture for mcpaql-channel paired tests",
  ]);
  f.issueNumMcpaql = JSON.parse(i2.stdout).number;

  // Parent issues for sub_issue_write
  console.log(`[setup] creating parent+sub issues for sub_issue_write...`);
  const p1 = await gh(["api", `/repos/${opts.owner}/${testRepo}/issues`, "-X", "POST", "-f", "title=Parent (official)"]);
  f.parentIssueOfficial = JSON.parse(p1.stdout).number;
  const p2 = await gh(["api", `/repos/${opts.owner}/${testRepo}/issues`, "-X", "POST", "-f", "title=Parent (mcpaql)"]);
  f.parentIssueMcpaql = JSON.parse(p2.stdout).number;
  const s1 = await gh(["api", `/repos/${opts.owner}/${testRepo}/issues`, "-X", "POST", "-f", "title=Sub (official)"]);
  f.subIssueIdOfficial = JSON.parse(s1.stdout).id;
  const s2 = await gh(["api", `/repos/${opts.owner}/${testRepo}/issues`, "-X", "POST", "-f", "title=Sub (mcpaql)"]);
  f.subIssueIdMcpaql = JSON.parse(s2.stdout).id;

  // Create paired PR fixture branches and separate branches for the create_pull_request
  // operation. Each branch gets a file commit so GitHub sees a real diff from base.
  console.log(`[setup] creating branches for PR fixtures...`);
  // Get default branch SHA
  const refs = await gh(["api", `/repos/${opts.owner}/${testRepo}/git/refs/heads/main`]);
  const sha = JSON.parse(refs.stdout).object.sha;
  const seededBranches = [
    { branch: "pr-branch-official", file: "pr-branch-official.txt" },
    { branch: "pr-branch-mcpaql", file: "pr-branch-mcpaql.txt" },
    { branch: "create-pr-branch-official", file: "create-pr-branch-official.txt" },
    { branch: "create-pr-branch-mcpaql", file: "create-pr-branch-mcpaql.txt" },
  ];
  for (const { branch, file } of seededBranches) {
    await gh([
      "api", `/repos/${opts.owner}/${testRepo}/git/refs`, "-X", "POST",
      "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`,
    ]);
    const content = Buffer.from(`Hello from ${branch}\n`).toString("base64");
    await gh([
      "api", `/repos/${opts.owner}/${testRepo}/contents/${file}`, "-X", "PUT",
      "-f", `message=seed ${branch}`, "-f", `content=${content}`, "-f", `branch=${branch}`,
    ]);
  }
  f.createPrBranchOfficial = "create-pr-branch-official";
  f.createPrBranchMcpaql = "create-pr-branch-mcpaql";
  f.prFileOfficial = "pr-branch-official.txt";
  f.prFileMcpaql = "pr-branch-mcpaql.txt";

  console.log(`[setup] creating PRs...`);
  const pr1 = await gh([
    "api", `/repos/${opts.owner}/${testRepo}/pulls`, "-X", "POST",
    "-f", "title=Parity test PR (official)", "-f", "head=pr-branch-official", "-f", "base=main",
    "-f", "body=PR for official-channel paired tests",
  ]);
  f.prNumOfficial = JSON.parse(pr1.stdout).number;
  const pr2 = await gh([
    "api", `/repos/${opts.owner}/${testRepo}/pulls`, "-X", "POST",
    "-f", "title=Parity test PR (mcpaql)", "-f", "head=pr-branch-mcpaql", "-f", "base=main",
    "-f", "body=PR for mcpaql-channel paired tests",
  ]);
  f.prNumMcpaql = JSON.parse(pr2.stdout).number;

  console.log(`[setup] creating pending reviews for add_comment_to_pending_review...`);
  try {
    await gh(["api", `/repos/${opts.owner}/${testRepo}/pulls/${f.prNumOfficial}/reviews`, "-X", "POST",
      "-f", "body=Pending review fixture (official)"]);
    await gh(["api", `/repos/${opts.owner}/${testRepo}/pulls/${f.prNumMcpaql}/reviews`, "-X", "POST",
      "-f", "body=Pending review fixture (mcpaql)"]);
  } catch (e) { console.warn(`  pending review creation failed: ${(e as Error).message.slice(0, 80)}`); }

  // ─── Extended setup for 89-op coverage ───

  // Enable discussions, secret scanning, vulnerability alerts on test repo (best-effort)
  console.log(`[setup] enabling repo features (discussions, secret scanning, vuln alerts)...`);
  try {
    await gh(["api", `/repos/${opts.owner}/${testRepo}`, "-X", "PATCH",
      "-F", "has_discussions=true"]);
  } catch (e) { console.warn(`  discussions enable: ${(e as Error).message.slice(0, 80)}`); }
  try {
    await gh(["api", `/repos/${opts.owner}/${testRepo}/vulnerability-alerts`, "-X", "PUT"]);
  } catch (e) { console.warn(`  vuln-alerts enable: ${(e as Error).message.slice(0, 80)}`); }
  try {
    await gh(["api", `/repos/${opts.owner}/${testRepo}`, "-X", "PATCH",
      "-f", "security_and_analysis[secret_scanning][status]=enabled"]);
  } catch (e) { console.warn(`  secret-scanning enable: ${(e as Error).message.slice(0, 80)}`); }

  // Create paired gists
  console.log(`[setup] creating paired gists...`);
  try {
    const g1 = await gh(["api", "/gists", "-X", "POST",
      "-f", `description=MCPAQL parity ${testRepo} fixture (official)`, "-F", "public=false",
      "-f", "files[parity-official.txt][content]=parity test gist via official channel"]);
    f.gistIdOfficial = JSON.parse(g1.stdout).id;
    const g2 = await gh(["api", "/gists", "-X", "POST",
      "-f", `description=MCPAQL parity ${testRepo} fixture (mcpaql)`, "-F", "public=false",
      "-f", "files[parity-mcpaql.txt][content]=parity test gist via mcpaql channel"]);
    f.gistIdMcpaql = JSON.parse(g2.stdout).id;
    console.log(`  gists: ${f.gistIdOfficial}, ${f.gistIdMcpaql}`);
  } catch (e) { console.warn(`  gist creation failed: ${(e as Error).message.slice(0, 80)}`); }

  // Discover first public discussion in publicDiscussionsRepo
  console.log(`[setup] resolving public discussion number...`);
  try {
    const disc = await gh(["api", "graphql", "-f", `query=query{repository(owner:"${f.publicDiscussionsOwner}",name:"${f.publicDiscussionsRepo}"){discussions(first:1){nodes{number}}}}`]);
    const num = JSON.parse(disc.stdout).data?.repository?.discussions?.nodes?.[0]?.number;
    if (num) { f.publicDiscussionNumber = num; console.log(`  discussion #${num}`); }
  } catch (e) { console.warn(`  discussion discovery failed: ${(e as Error).message.slice(0, 80)}`); }

  // Discover first workflow id in workflowOwner/workflowRepo
  console.log(`[setup] resolving workflow id...`);
  try {
    const wf = await gh(["api", `/repos/${f.workflowOwner}/${f.workflowRepo}/actions/workflows?per_page=1`]);
    const id = JSON.parse(wf.stdout).workflows?.[0]?.id;
    if (id) { f.workflowResourceId = String(id); console.log(`  workflow id ${id}`); }
  } catch (e) { console.warn(`  workflow discovery failed: ${(e as Error).message.slice(0, 80)}`); }

  // Discover caller's first project (user or org)
  console.log(`[setup] resolving caller's first project...`);
  try {
    const proj = await gh(["api", "graphql", "-f", `query=query{viewer{projectsV2(first:1){nodes{number title}}}}`]);
    const node = JSON.parse(proj.stdout).data?.viewer?.projectsV2?.nodes?.[0];
    if (node) { f.projectNumber = node.number; f.projectOwnerType = "user"; console.log(`  user project #${node.number} "${node.title}"`); }
  } catch (e) { console.warn(`  project discovery failed: ${(e as Error).message.slice(0, 80)}`); }

  // Capture first notification id (for get_notification_details)
  console.log(`[setup] capturing first notification id for read test...`);
  try {
    const n = await gh(["api", "/notifications?per_page=1"]);
    const list = JSON.parse(n.stdout);
    if (Array.isArray(list) && list[0]?.id) { f.notificationIdForRead = list[0].id; console.log(`  notification id ${list[0].id}`); }
  } catch (e) { console.warn(`  notification discovery failed: ${(e as Error).message.slice(0, 80)}`); }

  // Discover first Copilot Space (if any)
  console.log(`[setup] checking for existing Copilot Spaces...`);
  try {
    const cs = await gh(["api", "/copilot/spaces?per_page=1"]);
    const list = JSON.parse(cs.stdout);
    const space = Array.isArray(list?.spaces) ? list.spaces[0] : (Array.isArray(list) ? list[0] : null);
    if (space?.name) {
      f.copilotSpaceName = space.name;
      f.copilotSpaceOwner = space.owner?.login ?? opts.owner;
      console.log(`  copilot space: ${f.copilotSpaceOwner}/${f.copilotSpaceName}`);
    } else {
      console.log(`  no existing copilot space found; get_copilot_space will SKIP`);
    }
  } catch (e) { console.warn(`  copilot space discovery failed: ${(e as Error).message.slice(0, 80)}`); }

  console.log(`[setup] fixtures ready: repo=${testRepo} issues=${f.issueNumOfficial},${f.issueNumMcpaql} prs=${f.prNumOfficial},${f.prNumMcpaql}`);
  return f;
}

export async function teardownFixtures(f: Fixtures): Promise<void> {
  // Clean up paired gists first
  for (const [label, id] of [["official", f.gistIdOfficial], ["mcpaql", f.gistIdMcpaql]] as const) {
    if (!id) continue;
    try {
      await gh(["api", `/gists/${id}`, "-X", "DELETE"]);
      console.log(`[teardown] deleted gist (${label}): ${id}`);
    } catch (e) {
      console.warn(`[teardown] gist ${id} delete failed:`, (e as Error).message.slice(0, 80));
    }
  }

  try {
    const listed = await gh(["api", "/gists?per_page=100"]);
    const gists = JSON.parse(listed.stdout);
    const prefix = `MCPAQL parity ${f.testRepo} `;
    if (Array.isArray(gists)) {
      for (const gist of gists) {
        if (!gist?.id || typeof gist.description !== "string" || !gist.description.startsWith(prefix)) continue;
        try {
          await gh(["api", `/gists/${gist.id}`, "-X", "DELETE"]);
          console.log(`[teardown] deleted gist (swept): ${gist.id}`);
        } catch (e) {
          console.warn(`[teardown] gist ${gist.id} sweep delete failed:`, (e as Error).message.slice(0, 80));
        }
      }
    }
  } catch (e) {
    console.warn(`[teardown] gist sweep failed:`, (e as Error).message.slice(0, 80));
  }

  console.log(`[teardown] deleting ${f.owner}/${f.testRepo}...`);
  try {
    await gh(["repo", "delete", `${f.owner}/${f.testRepo}`, "--yes"]);
    console.log(`[teardown] deleted.`);
  } catch (e) {
    console.error(`[teardown] FAILED to delete repo:`, (e as Error).message);
    console.error(`[teardown] Manual cleanup: gh repo delete ${f.owner}/${f.testRepo} --yes`);
  }
}
