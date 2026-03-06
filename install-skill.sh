#!/usr/bin/env bash
# Install the bambu skill by symlinking into Claude Code and/or OpenClaw.
# Usage:
#   ./install-skill.sh              # install both
#   ./install-skill.sh claude       # Claude Code only
#   ./install-skill.sh openclaw     # OpenClaw only

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)/skill"

if [ ! -f "${SKILL_DIR}/SKILL.md" ]; then
  echo "Error: ${SKILL_DIR}/SKILL.md not found" >&2
  exit 1
fi

install_link() {
  local target_dir="$1"
  local link="${target_dir}/bambu"

  mkdir -p "${target_dir}"

  if [ -L "${link}" ]; then
    rm "${link}"
  elif [ -e "${link}" ]; then
    echo "Error: ${link} already exists and is not a symlink" >&2
    return 1
  fi

  ln -s "${SKILL_DIR}" "${link}"
  echo "Installed: ${link} -> ${SKILL_DIR}"
}

target="${1:-both}"

case "${target}" in
  claude)
    install_link "${HOME}/.claude/skills"
    ;;
  openclaw)
    install_link "${HOME}/.openclaw/skills"
    ;;
  both)
    install_link "${HOME}/.claude/skills"
    install_link "${HOME}/.openclaw/skills"
    ;;
  *)
    echo "Usage: $0 [claude|openclaw|both]" >&2
    exit 1
    ;;
esac
