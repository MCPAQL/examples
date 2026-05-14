# GitHub MCP Remote All Adapter

Generated MCP-AQL adapter package for GitHub MCP Server.

## Supported Endpoints

- READ: get_code_scanning_alert, get_commit, get_copilot_job_status, get_copilot_space, get_dependabot_alert, get_discussion, get_discussion_comments, get_file_contents, get_gist, get_global_security_advisory, get_job_logs, get_label, get_latest_release, get_me, get_notification_details, get_release_by_tag, get_repository_tree, get_secret_scanning_alert, get_tag, get_team_members, get_teams, issue_read, list_branches, list_code_scanning_alerts, list_commits, list_copilot_spaces, list_dependabot_alerts, list_discussion_categories, list_discussions, list_gists, list_global_security_advisories, list_issue_types, list_issues, list_label, list_notifications, list_org_repository_security_advisories, list_pull_requests, list_releases, list_repository_security_advisories, list_secret_scanning_alerts, list_starred_repositories, list_tags, mark_all_notifications_read, pull_request_read, search_code, search_issues, search_orgs, search_pull_requests, search_repositories, search_users
- EXECUTE: actions_get, actions_list, actions_run_trigger, check_dependency_vulnerabilities, dismiss_notification, github_support_docs_search, merge_pull_request, projects_get, projects_list, push_files, request_copilot_review, run_secret_scanning, semantic_issue_similarity_search, semantic_issues_search, star_repository, triage_issue, unstar_repository
- CREATE: add_comment_to_pending_review, add_issue_comment, add_reply_to_pull_request_comment, create_branch, create_gist, create_pull_request, create_pull_request_with_copilot, create_repository, fork_repository
- UPDATE: assign_copilot_to_issue, create_or_update_file, issue_write, label_write, sub_issue_write, update_gist, update_pull_request, update_pull_request_branch
- DELETE: delete_file, manage_notification_subscription, manage_repository_notification_subscription, projects_write, pull_request_review_write

## Running

Requires Node.js 20 or newer.

Set `MCPAQL_TARGET_BASE_URL` if you want this adapter to connect to a different upstream server than the bundled `https://api.githubcopilot.com/mcp`.

Set `GITHUB_PERSONAL_ACCESS_TOKEN` and run:

```bash
npm install
npm run start
```
