// GitHub-suite operation catalog. The runner library (in tools/parity-runner.ts) defines
// the Endpoint/Category/OperationSpec types; this file just supplies the GitHub-specific
// arg builders.

import type { OperationSpec } from "../../../../../tools/dist/parity-runner.js";
export type { Endpoint, Category } from "../../../../../tools/dist/parity-runner.js";

export interface Fixtures {
  // Set at start
  owner: string;
  testRepo: string;
  publicOwner: string;
  publicRepo: string;
  testOrg: string;
  testTeam?: string;

  // Resolved during setup
  projectOwnerType?: "user" | "org"; // discovered via projects_list
  projectNumber?: number;             // discovered via projects_list
  copilotSpaceName?: string;          // resolved or created during setup
  copilotSpaceOwner?: string;
  notificationIdForRead?: string;     // from list_notifications during setup (if any)

  // Branches (paired)
  branchOfficial?: string;
  branchMcpaql?: string;

  // Default branch on testRepo
  defaultBranch: string;

  // Issues (paired) — created via gh API during setup
  issueNumOfficial?: number;
  issueNumMcpaql?: number;

  // PRs (paired)
  prNumOfficial?: number;
  prNumMcpaql?: number;

  // Comment IDs collected during run
  issueCommentIdOfficial?: number;
  issueCommentIdMcpaql?: number;

  // Pending-review thread IDs
  pendingReviewBodyOfficial?: string;
  pendingReviewBodyMcpaql?: string;
  pendingReviewCommentIdOfficial?: number;
  pendingReviewCommentIdMcpaql?: number;

  // For sub_issue_write
  parentIssueOfficial?: number;
  parentIssueMcpaql?: number;
  subIssueIdOfficial?: number;
  subIssueIdMcpaql?: number;

  // Forks (paired) — name will be testRepo-fork-<variant>
  forkPublicTarget: { owner: string; repo: string };

  // ─── Extended fixtures for 89-op coverage ───
  // Gists (paired) — created during setup, deleted at teardown
  gistIdOfficial?: string;
  gistIdMcpaql?: string;

  // Public read targets for ops that need known external state
  publicDiscussionsOwner: string;   // a repo with discussions enabled
  publicDiscussionsRepo: string;
  publicDiscussionNumber?: number;  // resolved during setup by listing first discussion

  workflowOwner: string;            // public repo with workflows
  workflowRepo: string;
  workflowResourceId?: string;      // resolved during setup

  knownGhsaId: string;              // global security advisory

  // List captured during run — populated by list_notifications
  firstNotificationId?: string;
}

// (OperationSpec is imported from the runner library above; no local re-declaration.)

const TEST_FILE_PATH = "README.md";

export const OPERATIONS: Array<OperationSpec<Fixtures>> = [
  // ============= READ =============
  {
    name: "get_me",
    category: "PURE_READ",
    args: () => ({}),
  },
  {
    name: "search_repositories",
    category: "PURE_READ",
    args: () => ({ query: "stars:>50000 language:rust", page: 1, perPage: 5 }),
  },
  {
    name: "search_issues",
    category: "PURE_READ",
    args: () => ({ query: "is:issue is:open repo:octocat/Hello-World", page: 1, perPage: 3 }),
  },
  {
    name: "search_pull_requests",
    category: "PURE_READ",
    args: () => ({ query: "is:pr is:open repo:rust-lang/rust", page: 1, perPage: 3 }),
  },
  {
    name: "search_users",
    category: "PURE_READ",
    args: () => ({ query: "octocat", page: 1, perPage: 3 }),
  },
  {
    name: "search_code",
    category: "PURE_READ",
    args: () => ({ query: "addClass repo:jquery/jquery", page: 1, perPage: 3 }),
  },
  {
    name: "get_commit",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: f.publicOwner, repo: f.publicRepo, sha: "master", page: 1, perPage: 1 }),
  },
  {
    name: "list_commits",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: f.publicOwner, repo: f.publicRepo, page: 1, perPage: 3 }),
  },
  {
    name: "list_branches",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: f.publicOwner, repo: f.publicRepo, page: 1, perPage: 5 }),
  },
  {
    name: "list_tags",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: "torvalds", repo: "linux", page: 1, perPage: 3 }),
  },
  {
    name: "get_tag",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: "torvalds", repo: "linux", tag: "v6.0" }),
  },
  {
    name: "list_releases",
    category: "PUBLIC_READ",
    args: () => ({ owner: "cli", repo: "cli", page: 1, perPage: 3 }),
  },
  {
    name: "get_latest_release",
    category: "PUBLIC_READ",
    args: () => ({ owner: "cli", repo: "cli" }),
  },
  {
    name: "get_release_by_tag",
    category: "PUBLIC_READ",
    args: () => ({ owner: "cli", repo: "cli", tag: "v2.40.0" }),
  },
  {
    name: "get_file_contents",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo, path: TEST_FILE_PATH }),
  },
  {
    name: "get_label",
    category: "PUBLIC_READ",
    args: () => ({ owner: "cli", repo: "cli", name: "bug" }),
  },
  {
    name: "list_issues",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo, state: "open", page: 1, perPage: 5 }),
  },
  {
    name: "list_pull_requests",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo, state: "open", page: 1, perPage: 5 }),
  },
  {
    name: "issue_read",
    category: "PAIRED_WRITE", // paired so each end reads its own issue
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return { method: "get", owner: f.owner, repo: f.testRepo, issue_number: num };
    },
  },
  {
    name: "pull_request_read",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return { method: "get", owner: f.owner, repo: f.testRepo, pull_number: num };
    },
  },
  {
    name: "list_issue_types",
    category: "ORG_READ",
    args: (f) => ({ owner: f.testOrg }),
  },
  {
    name: "get_teams",
    category: "ORG_READ",
    args: (f) => ({ user: f.owner }),
  },
  {
    name: "get_team_members",
    category: "SKIP",
    args: () => null,
    note: "Requires team_slug + org admin scope; not feasible in default test environment.",
  },
  {
    name: "get_copilot_job_status",
    category: "COPILOT",
    args: () => ({ owner: "mickdarling", repo: "mcpaql-parity-test-fake", session_id: "fake" }),
    note: "Returns 404 with no Copilot job; we expect symmetric error.",
  },

  // ============= CREATE =============
  {
    name: "create_repository",
    category: "SKIP",
    args: () => null,
    note: "Test repo is created via gh CLI at setup (single repo, not paired). Tested implicitly.",
  },
  {
    name: "create_branch",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      branch: v === "official" ? f.branchOfficial! : f.branchMcpaql!,
      from_branch: f.defaultBranch,
    }),
  },
  {
    name: "create_pull_request",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      title: `Parity test PR (${v})`,
      head: v === "official" ? f.branchOfficial! : f.branchMcpaql!,
      base: f.defaultBranch,
      body: `Created by parity harness via ${v} channel.`,
    }),
  },
  {
    name: "add_issue_comment",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return { owner: f.owner, repo: f.testRepo, issue_number: num, body: `comment via ${v}` };
    },
  },
  {
    name: "add_comment_to_pending_review",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return {
        owner: f.owner,
        repo: f.testRepo,
        pull_number: num,
        path: TEST_FILE_PATH,
        body: `pending review comment via ${v}`,
        subject_type: "file",
      };
    },
    note: "Requires create method in pull_request_review_write to have created a pending review first.",
  },
  {
    name: "add_reply_to_pull_request_comment",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      const cid = v === "official" ? f.pendingReviewCommentIdOfficial : f.pendingReviewCommentIdMcpaql;
      if (!num || !cid) return null;
      return { owner: f.owner, repo: f.testRepo, pull_number: num, comment_id: cid, body: `reply via ${v}` };
    },
  },
  {
    name: "fork_repository",
    category: "SKIP",
    args: () => null,
    note: "Forking creates a real repo under user account that conflicts on second test run; needs separate cleanup. Tested manually instead.",
  },

  // ============= UPDATE =============
  {
    name: "issue_write",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return {
        method: "update",
        owner: f.owner,
        repo: f.testRepo,
        issue_number: num,
        body: `updated via ${v} at ${new Date().toISOString().slice(0, 10)}`,
      };
    },
  },
  {
    name: "create_or_update_file",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      path: `parity/${v}.txt`,
      message: `parity test ${v}`,
      content: Buffer.from(`hello from ${v}\n`).toString("base64"),
      branch: f.defaultBranch,
    }),
  },
  {
    name: "update_pull_request",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return {
        owner: f.owner,
        repo: f.testRepo,
        pull_number: num,
        title: `Parity test PR (${v}) [updated]`,
      };
    },
  },
  {
    name: "update_pull_request_branch",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return { owner: f.owner, repo: f.testRepo, pull_number: num };
    },
    note: "May 422 if already up to date — symmetric error counts as parity.",
  },
  {
    name: "pull_request_review_write",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return {
        method: "create",
        owner: f.owner,
        repo: f.testRepo,
        pull_number: num,
        body: `pending review via ${v}`,
      };
    },
  },
  {
    name: "sub_issue_write",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const parent = v === "official" ? f.parentIssueOfficial : f.parentIssueMcpaql;
      const sub = v === "official" ? f.subIssueIdOfficial : f.subIssueIdMcpaql;
      if (!parent || !sub) return null;
      return {
        method: "add",
        owner: f.owner,
        repo: f.testRepo,
        issue_number: parent,
        sub_issue_id: sub,
      };
    },
  },
  {
    name: "assign_copilot_to_issue",
    category: "COPILOT",
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return { owner: f.owner, repo: f.testRepo, issueNumber: num };
    },
  },

  // ============= DELETE =============
  {
    name: "delete_file",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      path: `parity/${v}.txt`,
      message: `delete parity test ${v}`,
      branch: f.defaultBranch,
    }),
    note: "Depends on create_or_update_file having succeeded first.",
  },

  // ============= EXECUTE =============
  {
    name: "merge_pull_request",
    category: "ONESHOT_WRITE",
    args: (f, v) => {
      // Run via MCPAQL on the mcpaql PR; verify via official read.
      if (v === "official") return null;
      if (!f.prNumMcpaql) return null;
      return {
        owner: f.owner,
        repo: f.testRepo,
        pull_number: f.prNumMcpaql,
        merge_method: "squash",
      };
    },
    verify: {
      name: "pull_request_read",
      args: (f) => {
        if (!f.prNumMcpaql) return null;
        return { method: "get", owner: f.owner, repo: f.testRepo, pull_number: f.prNumMcpaql };
      },
    },
    note: "PR can only merge once; uses MCPAQL to merge, verifies via direct read showing merged=true.",
  },
  {
    name: "push_files",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      branch: v === "official" ? f.branchOfficial! : f.branchMcpaql!,
      message: `push_files via ${v}`,
      files: [{ path: `parity/push-${v}.txt`, content: `pushed via ${v}\n` }],
    }),
  },
  {
    name: "run_secret_scanning",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
    note: "Public repos get free secret scanning; expect symmetric empty result.",
  },
  {
    name: "create_pull_request_with_copilot",
    category: "COPILOT",
    args: (f, v) => ({
      owner: f.owner,
      repo: f.testRepo,
      problem_statement: `parity test problem (${v}): add a hello.md file`,
      title: `Copilot parity (${v})`,
      base_ref: f.defaultBranch,
    }),
  },
  {
    name: "request_copilot_review",
    category: "COPILOT",
    args: (f, v) => {
      const num = v === "official" ? f.prNumOfficial : f.prNumMcpaql;
      if (!num) return null;
      return { owner: f.owner, repo: f.testRepo, pullNumber: num };
    },
  },

  // ═════════════════════════════════════════════════════════════════════
  //  EXTENDED COVERAGE — 45 operations only present with X-MCP-Toolsets=all
  // ═════════════════════════════════════════════════════════════════════

  // ─── Gists (4) — paired writes against user account, cleaned up at teardown ───
  {
    name: "create_gist",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      filename: `parity-${v}.txt`,
      content: `parity test gist via ${v} channel`,
      description: `parity test (${v})`,
      public: false,
    }),
  },
  {
    name: "list_gists",
    category: "PURE_READ",
    args: () => ({ page: 1, perPage: 5 }),
    note: "Lists caller's gists; may include the gists created in this run.",
  },
  {
    name: "get_gist",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const id = v === "official" ? f.gistIdOfficial : f.gistIdMcpaql;
      if (!id) return null;
      return { gist_id: id };
    },
  },
  {
    name: "update_gist",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const id = v === "official" ? f.gistIdOfficial : f.gistIdMcpaql;
      if (!id) return null;
      return { gist_id: id, filename: `parity-${v}.txt`, content: `updated via ${v}` };
    },
  },

  // ─── Discussions (4) — public-repo reads ───
  {
    name: "list_discussions",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: f.publicDiscussionsOwner, repo: f.publicDiscussionsRepo, perPage: 3 }),
  },
  {
    name: "list_discussion_categories",
    category: "PUBLIC_READ",
    args: (f) => ({ owner: f.publicDiscussionsOwner, repo: f.publicDiscussionsRepo }),
  },
  {
    name: "get_discussion",
    category: "PUBLIC_READ",
    args: (f) => {
      if (!f.publicDiscussionNumber) return null;
      return {
        owner: f.publicDiscussionsOwner,
        repo: f.publicDiscussionsRepo,
        discussion_number: f.publicDiscussionNumber,
      };
    },
  },
  {
    name: "get_discussion_comments",
    category: "PUBLIC_READ",
    args: (f) => {
      if (!f.publicDiscussionNumber) return null;
      return {
        owner: f.publicDiscussionsOwner,
        repo: f.publicDiscussionsRepo,
        discussion_number: f.publicDiscussionNumber,
      };
    },
  },

  // ─── Notifications (6) — mostly SKIPPED (destructive to real user account) ───
  {
    name: "list_notifications",
    category: "SKIP",
    args: () => null,
    note: "Requires 'notifications' OAuth scope on the gh token (gh auth refresh -s notifications). Standard repo-scope tokens get HTTP 403.",
  },
  {
    name: "get_notification_details",
    category: "SKIP",
    args: () => null,
    note: "Same scope dependency as list_notifications.",
  },
  {
    name: "dismiss_notification",
    category: "SKIP",
    args: () => null,
    note: "Dismisses one of the caller's real notifications; not run because mark_all_notifications_read covers the bulk-state action.",
  },
  {
    name: "mark_all_notifications_read",
    category: "SKIP",
    args: () => null,
    note: "Same scope dependency as list_notifications.",
  },
  {
    name: "manage_notification_subscription",
    category: "SKIP",
    args: () => null,
    note: "Mutates real thread-level notification subscription state; would need a specific notification_id we own.",
  },
  {
    name: "manage_repository_notification_subscription",
    category: "SKIP",
    args: () => null,
    note: "Same scope dependency as list_notifications.",
  },

  // ─── Code scanning (2) — test repo has feature enabled; expect empty alert lists ───
  {
    name: "list_code_scanning_alerts",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
  },
  {
    name: "get_code_scanning_alert",
    category: "SKIP",
    args: () => null,
    note: "Requires alert_number; fresh test repo has no real code scanning alerts.",
  },

  // ─── Dependabot (3) — test repo has feature enabled; expect empty lists ───
  {
    name: "list_dependabot_alerts",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
  },
  {
    name: "get_dependabot_alert",
    category: "SKIP",
    args: () => null,
    note: "Requires alert_number; fresh test repo has no real Dependabot alerts.",
  },
  {
    name: "check_dependency_vulnerabilities",
    category: "TEST_REPO_READ",
    args: (f) => ({
      owner: f.owner,
      repo: f.testRepo,
      dependencies: [{ name: "lodash", version: "4.17.0", ecosystem: "npm" }],
    }),
    note: "Checks a known-vulnerable lodash version; both sides should return the same advisories.",
  },

  // ─── Secret scanning alerts (2) ───
  {
    name: "list_secret_scanning_alerts",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
  },
  {
    name: "get_secret_scanning_alert",
    category: "SKIP",
    args: () => null,
    note: "Requires alert_number; fresh test repo has no real secret scanning alerts.",
  },

  // ─── Actions / workflows (4) — read against a public repo with workflows ───
  {
    name: "actions_list",
    category: "PUBLIC_READ",
    args: (f) => ({ method: "list_workflows", owner: f.workflowOwner, repo: f.workflowRepo, perPage: 3 }),
  },
  {
    name: "actions_get",
    category: "PUBLIC_READ",
    args: (f) => {
      if (!f.workflowResourceId) return null;
      return { method: "get_workflow", owner: f.workflowOwner, repo: f.workflowRepo, resource_id: f.workflowResourceId };
    },
  },
  {
    name: "actions_run_trigger",
    category: "SKIP",
    args: () => null,
    note: "Would trigger a real workflow run; requires write access and is destructive on third-party repos.",
  },
  {
    name: "get_job_logs",
    category: "SKIP",
    args: () => null,
    note: "Requires a specific job ID; test repo has no workflow runs.",
  },

  // ─── Security advisories (4) — globals are public reads; org/repo-scoped require setup ───
  {
    name: "list_global_security_advisories",
    category: "PURE_READ",
    args: () => ({ perPage: 3 }),
  },
  {
    name: "get_global_security_advisory",
    category: "PURE_READ",
    args: (f) => ({ ghsa_id: f.knownGhsaId }),
  },
  {
    name: "list_repository_security_advisories",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
  },
  {
    name: "list_org_repository_security_advisories",
    category: "ORG_READ",
    args: (f) => ({ org: f.testOrg }),
  },

  // ─── Copilot Spaces (2) — list works empty; get needs a real space ───
  {
    name: "list_copilot_spaces",
    category: "PURE_READ",
    args: () => ({}),
  },
  {
    name: "get_copilot_space",
    category: "PURE_READ",
    args: (f) => {
      if (!f.copilotSpaceName || !f.copilotSpaceOwner) return null;
      return { owner: f.copilotSpaceOwner, name: f.copilotSpaceName };
    },
    note: "Reads a Copilot Space if one was discovered at setup. Falls back to SKIP if none exist.",
  },

  // ─── Projects (3) — SKIPPED (would require pre-existing GitHub Project) ───
  {
    name: "projects_list",
    category: "PUBLIC_READ",
    args: (f) => ({ method: "list", owner: f.owner }),
    note: "Lists caller's projects; returns whatever's there (may be empty).",
  },
  {
    name: "projects_get",
    category: "PURE_READ",
    args: (f) => {
      if (!f.projectNumber) return null;
      return {
        method: "get",
        owner: f.owner,
        owner_type: f.projectOwnerType ?? "user",
        project_number: f.projectNumber,
      };
    },
    note: "Reads caller's first project (discovered via projects_list at setup).",
  },
  {
    name: "projects_write",
    category: "SKIP",
    args: () => null,
    note: "Mutates a real project. Not exercised here to avoid changing the user's project state.",
  },

  // ─── Stars (3) — paired writes against test repo (gets deleted anyway) ───
  {
    name: "star_repository",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
    note: "Stars the test repo. Symmetric — both ends starring same repo is idempotent.",
  },
  {
    name: "list_starred_repositories",
    category: "PURE_READ",
    args: () => ({ perPage: 3 }),
  },
  {
    name: "unstar_repository",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
    note: "Unstars test repo. Idempotent same-target; expected symmetric.",
  },

  // ─── Support docs (1) ───
  {
    name: "github_support_docs_search",
    category: "PURE_READ",
    args: () => ({ query: "personal access token scopes" }),
  },

  // ─── Semantic search (2) ───
  {
    name: "semantic_issues_search",
    category: "PUBLIC_READ",
    args: (f) => ({ query: "memory leak", owner: f.publicOwner, repo: f.publicRepo }),
  },
  {
    name: "semantic_issue_similarity_search",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return { owner: f.owner, repo: f.testRepo, issue_number: num };
    },
  },

  // ─── Misc (5) ───
  {
    name: "search_orgs",
    category: "PURE_READ",
    args: () => ({ query: "github", perPage: 3 }),
  },
  {
    name: "get_repository_tree",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo }),
  },
  {
    name: "list_label",
    category: "TEST_REPO_READ",
    args: (f) => ({ owner: f.owner, repo: f.testRepo, perPage: 5 }),
  },
  {
    name: "label_write",
    category: "PAIRED_WRITE",
    args: (f, v) => ({
      method: "create",
      owner: f.owner,
      repo: f.testRepo,
      name: `parity-${v}`,
      color: v === "official" ? "ff0000" : "0000ff",
      description: `parity test label (${v})`,
    }),
  },
  {
    name: "triage_issue",
    category: "PAIRED_WRITE",
    args: (f, v) => {
      const num = v === "official" ? f.issueNumOfficial : f.issueNumMcpaql;
      if (!num) return null;
      return {
        owner: f.owner,
        repo: f.testRepo,
        issue_number: num,
        triage_rationale: `parity test triage (${v})`,
      };
    },
    note: "Copilot-assisted issue triage. May require entitlement.",
  },
];

// The runner library handles lookup-by-name; suites don't need OP_BY_NAME.
