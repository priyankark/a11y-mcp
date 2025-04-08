# A11y MCP Server

An MCP (Model Context Protocol) server for performing accessibility audits on webpages using axe-core.

## Features

- Perform detailed accessibility audits on any webpage
- Get a summary of accessibility issues
- Filter audits by specific WCAG criteria
- Include HTML snippets in the results for easier debugging

## Installation

```bash
# Install globally
npm install -g a11y-mcp

# Or use directly with npx
npx a11y-mcp
```

## Configuration

To use this MCP server with Cline, you need to add it to your MCP settings configuration file.

### For Claude Desktop App

Edit the file at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent path on your operating system.

Add the following to the `mcpServers` object:

```json
{
  "mcpServers": {
    "a11y": {
      "command": "npx",
      "args": ["a11y-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### For Claude VSCode Extension

Edit the file at `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS) or the equivalent path on your operating system.

Add the following to the `mcpServers` object:

```json
{
  "mcpServers": {
    "a11y": {
      "command": "npx",
      "args": ["a11y-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Available Tools

### audit_webpage

Performs a detailed accessibility audit on a webpage.

**Parameters:**
- `url` (required): URL of the webpage to audit
- `includeHtml` (optional): Whether to include HTML snippets in the results (default: false)
- `tags` (optional): Array of specific accessibility tags to check (e.g., wcag2a, wcag2aa, wcag21a, best-practice)

**Example:**
```
Use the a11y MCP server to audit example.com for accessibility issues
```

### get_summary

Gets a summary of accessibility issues for a webpage.

**Parameters:**
- `url` (required): URL of the webpage to audit

**Example:**
```
Give me an accessibility summary of example.com
```

## Example Usage

Once configured, you can ask Claude to use the MCP server to perform accessibility audits:

1. "Can you check example.com for accessibility issues?"
2. "Audit my website at https://mywebsite.com for WCAG 2.1 AA compliance"
3. "Give me a summary of accessibility issues on https://example.com"
4. "Check if my local development server at http://localhost:3000 has any critical accessibility problems"

## Development

To run the server locally for development:

```bash
npm start
```

## Releasing

This project includes a release script to help with versioning and publishing to npm. The script handles version bumping, running tests, git tagging, and npm publishing.

To release a new version:

```bash
# Make sure the script is executable
chmod +x release.sh

# Release a patch version (default)
./release.sh

# Release a minor version
./release.sh --minor

# Release a major version
./release.sh --major

# Release a specific version
./release.sh --version=1.2.3

# Skip running tests
./release.sh --skip-tests

# Skip git operations
./release.sh --skip-git

# Dry run (no changes will be made)
./release.sh --dry-run

# Force release even with uncommitted changes
./release.sh --force
```

For more information, run:

```bash
./release.sh --help
```

## License

ISC
