# GitHub MCP

Generated MCP-AQL adapter package for the official GitHub MCP server.

## Supported Endpoints

- READ: get_commit, get_copilot_job_status, get_file_contents, get_label, get_latest_release, get_me, get_release_by_tag, get_tag, get_team_members, get_teams, issue_read, list_branches, list_commits, list_issue_types, list_issues, list_pull_requests, list_releases, list_tags, pull_request_read, search_code, search_issues, search_pull_requests, search_repositories, search_users
- CREATE: add_comment_to_pending_review, add_issue_comment, add_reply_to_pull_request_comment, create_branch, create_pull_request, create_repository, fork_repository
- UPDATE: assign_copilot_to_issue, create_or_update_file, issue_write, pull_request_review_write, sub_issue_write, update_pull_request, update_pull_request_branch
- EXECUTE: create_pull_request_with_copilot, merge_pull_request, push_files, request_copilot_review, run_secret_scanning
- DELETE: delete_file

## Running

Requires Node.js 20 or newer.

Set `GITHUB_PERSONAL_ACCESS_TOKEN` and run:

```bash
npm install
npm run start
```
