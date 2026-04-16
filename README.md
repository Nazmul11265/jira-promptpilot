# PromptPilot

> **Autonomous Jira-to-Code Agent — MCP Server for VS Code**
>
> Give it a ticket ID. It investigates your codebase, reasons about the root cause, and returns a production-ready Copilot prompt — automatically.

---

## What It Does

```
You type:  "Use fix_jira_ticket for PROJ-123"
     ↓
PromptPilot fetches the Jira ticket
     ↓
Llama 3.3 (via Groq) runs a ReAct reasoning loop:
  THINK → search codebase → OBSERVE results → REFLECT → read file → OBSERVE → REFLECT → generate prompt
     ↓
A structured VS Code Copilot prompt lands in your chat
     ↓
You say "implement this" — Copilot writes the fix
```

---

## Architecture

```
VS Code Copilot Chat
       ↓  MCP tool call
PromptPilot MCP Server  (Node.js · stdio transport)
       ↓
┌──────────────────────────────────────────────────┐
│  Phase 1 │ Cross-run Memory      .promptpilot/   │
│  Phase 2 │ Ticket Pre-fetch      Jira REST v3    │
│  Phase 3 │ Planning              Groq / Llama    │
│  Phase 4 │ ReAct Loop (max 10)   Groq / Llama    │
│           │  THINK → ACT → OBSERVE → REFLECT      │
│  Phase 5 │ Memory Persist        disk (JSON)     │
│  Phase 6 │ Prompt Generation     structured      │
└──────────────────────────────────────────────────┘
```

### Tool the agent can call internally

| Tool | Purpose |
|---|---|
| `fetch_jira_ticket` | Jira REST API v3 — full ticket data, ADF parsed to plain text |
| `search_workspace` | Glob + full-text search across all project files |
| `read_file` | Read a specific file with optional line range |
| `generate_prompt` | Format findings into a structured Copilot prompt (terminal step) |

---

## Project Structure

```
jira-promptpilot/
├── src/
│   ├── index.js          # MCP server — exposes fix_jira_ticket tool
│   ├── agent.js          # ReAct loop: planning, memory, stall recovery
│   ├── memory.js         # Cross-run persistence (.promptpilot/memory.json)
│   └── tools/
│       ├── jira.js       # Jira REST API client + mock fallback
│       ├── workspace.js  # search_workspace + read_file (path-traversal safe)
│       └── prompt.js     # Formats findings into a Copilot prompt
├── .vscode/
│   └── mcp.json          # MCP server config for this workspace
├── .env.example          # Environment variable template
└── package.json
```

---

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **Groq API key** — free tier available at [console.groq.com](https://console.groq.com)
- **Jira API token** *(optional)* — omit to use built-in mock data for testing

---

## Setup

**1. Install dependencies**

```bash
cd jira-promptpilot
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env`:

```env
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile

# Optional — leave blank to use mock ticket data
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=ATATT3x...
```

**3. Register as a global MCP server**

Create (or edit) `C:\Users\<you>\AppData\Roaming\Code\User\mcp.json`:

```json
{
  "servers": {
    "jira-promptpilot": {
      "type": "stdio",
      "command": "node",
      "args": ["e:/Office training/jira-promptpilot/src/index.js"],
      "envFile": "e:/Office training/jira-promptpilot/.env"
    }
  }
}
```

**4. Start the server**

- `Ctrl+Shift+P` → **MCP: List Servers** → **jira-promptpilot** → **Start**

---

## Usage

Open **Copilot Chat** (`Ctrl+Alt+I`) in any workspace and type:

```
Use fix_jira_ticket with ticket_id PROJ-123
```

To point the agent at a specific workspace root:

```
Use fix_jira_ticket with ticket_id PROJ-123 and workspace_root C:/path/to/project
```

The agent will respond with a structured prompt like:

```markdown
# Bug: Login button unresponsive on mobile devices

## Root Cause
onClick handler in LoginButton.jsx has no touch event handling (touchstart/touchend).
Mobile Safari and Android Chrome require explicit touch events on custom button components.

## Files to Modify
- `src/components/LoginButton.jsx`

## Proposed Fix
1. Add onTouchEnd handler mirroring the existing onClick handler
2. Add touch-action: manipulation CSS to prevent 300ms tap delay
...
```

---

## Local Testing (no Jira, no VS Code)

```bash
# Uses mock ticket data — tests the full ReAct loop
node test-agent.js

# Real ticket
node test-agent.js PROJ-123

# Real ticket + specific workspace
node test-agent.js PROJ-123 "C:/path/to/project"
```

---

## Agentic Design

### What makes it agentic

| Feature | Detail |
|---|---|
| **Dynamic tool selection** | Llama decides which tool to call — no hardcoded sequence |
| **ReAct reasoning** | THINK / OBSERVE / REFLECT sections parsed and logged each iteration |
| **Planning phase** | Separate LLM call before the loop produces `goal`, `steps`, `key_unknowns` |
| **Cross-run memory** | Findings saved to `.promptpilot/memory.json` — repeated tickets are faster |
| **Stall recovery** | Detects text-only responses and nudges the model back to real function calls |
| **Path-safe search** | All file access validated against workspace root (no path traversal) |

### Current scope (POC)

The agent is an **autonomous investigator** — it researches and reasons, then hands a prompt to Copilot for execution. Automated code writing, test running, and Jira status transitions are out of scope for this POC.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Groq API key |
| `GROQ_MODEL` | No | Model name (default: `llama-3.3-70b-versatile`) |
| `JIRA_BASE_URL` | No | e.g. `https://company.atlassian.net` |
| `JIRA_EMAIL` | No | Jira account email |
| `JIRA_API_TOKEN` | No | Jira API token (not your password) |

---

## Security Notes

- The `.env` file is **never** sent to any server except as environment variables to your local Node.js process
- Jira credentials use **Basic Auth over HTTPS** — the token is base64-encoded, not stored in code
- Workspace file access is restricted to the declared `workspace_root` via path validation
- Add `.env` to your `.gitignore` — never commit real credentials

---

## License

MIT
