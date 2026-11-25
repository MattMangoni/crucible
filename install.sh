#!/bin/sh
# Link the crucible skill and CLI into $HOME. Safe to re-run.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)

link() {
  if [ "$(readlink "$2" 2>/dev/null || true)" = "$1" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    mv "$2" "$2.bak"
    echo "backed up $2 -> $2.bak"
  fi
  ln -sfn "$1" "$2"
  echo "linked $2 -> $1"
}

chmod +x "$DIR/bin/crucible.mjs"

link "$DIR/bin/crucible.mjs" "$HOME/.local/bin/crucible"
link "$DIR/skills/crucible" "$HOME/.agents/skills/crucible"
link "$DIR/skills/crucible" "$HOME/.claude/skills/crucible"

echo "Done. Ensure ~/.local/bin is in your PATH."
echo "Optional user config: ~/.config/crucible/config.json"
