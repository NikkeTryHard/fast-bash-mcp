#!/bin/bash
# Fast Bash MCP Server Installer for Claude Code

set -e

INSTALL_DIR="$HOME/.claude/mcp-servers/fast-bash"
MCP_CONFIG="$HOME/.claude/.mcp.json"

echo "Installing Fast Bash MCP Server..."

# Check for bun
if ! command -v bun &> /dev/null; then
    echo "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download files
echo "Downloading server files..."
curl -sSL "https://raw.githubusercontent.com/nikketryhard/fast-bash-mcp/main/src/index.ts" -o "$INSTALL_DIR/index.ts"
curl -sSL "https://raw.githubusercontent.com/nikketryhard/fast-bash-mcp/main/package.json" -o "$INSTALL_DIR/package.json"

# Install dependencies
echo "Installing dependencies..."
cd "$INSTALL_DIR"
bun install

# Create MCP config
echo "Configuring MCP server..."
mkdir -p "$(dirname "$MCP_CONFIG")"

if [ -f "$MCP_CONFIG" ]; then
    # Check if fast-bash already configured
    if grep -q "fast-bash" "$MCP_CONFIG"; then
        echo "fast-bash already configured in $MCP_CONFIG"
    else
        echo "Adding fast-bash to existing config..."
        # Use jq if available, otherwise manual merge
        if command -v jq &> /dev/null; then
            jq '.mcpServers["fast-bash"] = {
                "command": "bun",
                "args": ["run", "'"$INSTALL_DIR/index.ts"'"],
                "env": {"FAST_BASH_DEFAULT_CWD": "${PWD}"}
            }' "$MCP_CONFIG" > "$MCP_CONFIG.tmp" && mv "$MCP_CONFIG.tmp" "$MCP_CONFIG"
        else
            echo "Please manually add fast-bash to $MCP_CONFIG"
            echo "See README for configuration details."
        fi
    fi
else
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "fast-bash": {
      "command": "bun",
      "args": ["run", "$INSTALL_DIR/index.ts"],
      "env": {
        "FAST_BASH_DEFAULT_CWD": "\${PWD}"
      }
    }
  }
}
EOF
fi

echo ""
echo "Installation complete!"
echo ""
echo "To use fast-bash, restart Claude Code."
echo ""
echo "Optional: Disable built-in Bash by adding to ~/.claude/settings.json:"
echo '  "permissions": { "deny": ["Bash"] }'
echo ""
echo "Optional: Add instructions to ~/.claude/CLAUDE.md:"
echo "  BASH COMMANDS"
echo "  0. ALWAYS use fast-bash MCP tools instead of the built-in Bash tool."
echo "  1. Use mcp__fast-bash__fast_bash for single commands"
echo "  2. Use mcp__fast-bash__fast_bash_parallel for multiple independent commands"
echo "  3. Use mcp__fast-bash__fast_bash_bg for long-running commands"
echo ""
