---
name: apple-mail
type: adapter
version: "1.0.0"
description: "Adapter for Apple Mail on macOS, enabling email management through MCP-AQL via native AppleScript/JXA"

author: "MCP-AQL Specification Team"
tags:
  - apple-mail
  - email
  - macos
  - native-applescript
  - jxa
triggers:
  - mail
  - email
  - message
  - inbox
created: "2026-04-04T00:00:00Z"
modified: "2026-04-04T00:00:00Z"

target:
  base_url: "native-applescript://Mail"
  transport: native-applescript
  protocol: custom
  serialization: json
  application: Mail

operations:
  create:
    - name: create_outgoing_message
      maps_to: "native-applescript:command:make"
      description: "Create a new outgoing email message"
      params:
        subject:
          type: string
          required: true
          description: "The subject of the message"
        content:
          type: string
          required: true
          description: "The body text of the message"
        sender:
          type: string
          description: "The sender email address (defaults to default account)"
        to_recipients:
          type: array
          required: true
          description: "List of recipient email addresses"
        cc_recipients:
          type: array
          description: "List of CC recipient email addresses"
        visible:
          type: boolean
          default: true
          description: "Whether to show the compose window"

  read:
    - name: list_accounts
      maps_to: "native-applescript:command:list_accounts"
      description: "List all configured email accounts"

    - name: get_account
      maps_to: "native-applescript:get_property:account.name"
      description: "Get the name of a specific email account"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"

    - name: list_mailboxes
      maps_to: "native-applescript:list_elements:account.mailbox"
      description: "List mailboxes in an account"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"

    - name: list_messages
      maps_to: "native-applescript:command:list_messages"
      description: "List messages in a mailbox"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox (e.g., INBOX)"
        limit:
          type: integer
          default: 20
          description: "Maximum number of messages to return"

    - name: get_message
      maps_to: "native-applescript:command:get_message"
      description: "Get full details of a specific message including body content"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID. Note: this is a positional index within the mailbox and may change as messages are added or removed"

    - name: search_messages
      maps_to: "native-applescript:command:search_messages"
      description: "Search messages by subject line (subject-only match; does not search body or other fields)"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox to search"
        query:
          type: string
          required: true
          description: "Search text to match in subject"
        limit:
          type: integer
          default: 20
          description: "Maximum number of results"

    - name: get_unread_count
      maps_to: "native-applescript:get_property:mailbox.unreadCount"
      description: "Get the unread message count for a mailbox"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"

  update:
    - name: mark_read
      maps_to: "native-applescript:set_property:message.readStatus"
      description: "Mark a message as read or unread"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID"
        read_status:
          type: boolean
          required: true
          description: "True to mark as read, false for unread"

    - name: mark_flagged
      maps_to: "native-applescript:set_property:message.flaggedStatus"
      description: "Flag or unflag a message"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID"
        flagged_status:
          type: boolean
          required: true
          description: "True to flag, false to unflag"

    - name: mark_junk
      maps_to: "native-applescript:set_property:message.junkMailStatus"
      description: "Mark or unmark a message as junk"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID"
        junk_status:
          type: boolean
          required: true
          description: "True to mark as junk, false to unmark"

  delete:
    - name: delete_message
      maps_to: "native-applescript:command:delete"
      description: "Delete a message (moves to trash)"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        mailbox_name:
          type: string
          required: true
          description: "Name of the mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID to delete"

  execute:
    - name: send_message
      maps_to: "native-applescript:command:send"
      description: "Send an outgoing message"
      params:
        message_id:
          type: integer
          required: true
          description: "The ID of the outgoing message to send"

    - name: move_message
      maps_to: "native-applescript:command:move"
      description: "Move a message to a different mailbox"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account"
        source_mailbox:
          type: string
          required: true
          description: "Name of the source mailbox"
        destination_mailbox:
          type: string
          required: true
          description: "Name of the destination mailbox"
        message_id:
          type: integer
          required: true
          description: "The message ID to move"

    - name: check_for_new_mail
      maps_to: "native-applescript:command:checkForNewMail"
      description: "Check all accounts for new mail"

    - name: check_account_for_new_mail
      maps_to: "native-applescript:command:checkForNewMailFor"
      description: "Check a specific account for new mail"
      params:
        account_name:
          type: string
          required: true
          description: "Name of the email account to check"
---

# Apple Mail Adapter

## Overview

This adapter provides MCP-AQL access to Apple Mail on macOS via the native AppleScript/JXA transport. It enables LLMs to manage email through the unified CRUDE interface without requiring any network connectivity or API keys.

## Requirements

- macOS with Apple Mail configured
- At least one email account set up in Mail.app
- Mail.app must be running for operations to succeed

## Transport

This adapter uses the `native-applescript` transport plugin, which executes operations locally via `osascript` (JXA - JavaScript for Automation). All parameters are sanitized before interpolation into script templates to prevent injection attacks.

## Operations Overview

### CREATE Operations

| Operation | Description |
|-----------|-------------|
| `create_outgoing_message` | Create a new email (compose window) |

### READ Operations

| Operation | Description |
|-----------|-------------|
| `list_accounts` | List configured email accounts |
| `get_account` | Get account details |
| `list_mailboxes` | List mailboxes in an account |
| `list_messages` | List messages in a mailbox |
| `get_message` | Get full message content |
| `search_messages` | Search by subject text |
| `get_unread_count` | Get unread count for a mailbox |

### UPDATE Operations

| Operation | Description |
|-----------|-------------|
| `mark_read` | Mark message read/unread |
| `mark_flagged` | Flag/unflag a message |
| `mark_junk` | Mark/unmark as junk |

### DELETE Operations

| Operation | Description |
|-----------|-------------|
| `delete_message` | Move message to trash |

### EXECUTE Operations

| Operation | Description |
|-----------|-------------|
| `send_message` | Send a composed message |
| `move_message` | Move message between mailboxes |
| `check_for_new_mail` | Check all accounts |
| `check_account_for_new_mail` | Check specific account |

## Usage Examples

### List Accounts

```json
{
  "operation": "list_accounts",
  "params": {}
}
```

### List Messages in Inbox

```json
{
  "operation": "list_messages",
  "params": {
    "account_name": "iCloud",
    "mailbox_name": "INBOX",
    "limit": 10
  }
}
```

### Read a Message

```json
{
  "operation": "get_message",
  "params": {
    "account_name": "iCloud",
    "mailbox_name": "INBOX",
    "message_id": 12345
  }
}
```

### Search Messages

```json
{
  "operation": "search_messages",
  "params": {
    "account_name": "iCloud",
    "mailbox_name": "INBOX",
    "query": "invoice",
    "limit": 5
  }
}
```

### Mark as Read

```json
{
  "operation": "mark_read",
  "params": {
    "account_name": "iCloud",
    "mailbox_name": "INBOX",
    "message_id": 12345,
    "read_status": true
  }
}
```

## Security

All parameter values are sanitized via the native-applescript transport's sanitizer before interpolation into script templates. This prevents AppleScript injection attacks. The adapter runs with the current user's macOS permissions and does not escalate privileges.

## References

- [MCP-AQL Specification](https://github.com/MCPAQL/spec)
- [Native AppleScript Transport Plugin](https://github.com/MCPAQL/mcpaql-adapter) — see `src/plugins/transport/native-applescript.ts`
- Apple Mail Scripting Dictionary — located at `/Applications/Mail.app/Contents/Resources/Mail.sdef` (or `/System/Applications/Mail.app/Contents/Resources/Mail.sdef` on macOS 10.15+)
