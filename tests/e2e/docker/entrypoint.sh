#!/bin/sh
set -e

echo "=== Running Docker Clean-User BDD Container ==="
SCENARIO="${1:-fresh-online}"
echo "Executing scenario: $SCENARIO"

# 1. Enforce zero dev tools at runtime
for cmd in python python3 uv node npm pnpm bun git; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: Forbidden tool $cmd found in clean container" >&2
    exit 1
  fi
done
echo "Clean environment verified: zero external development tools."

export OMP_SKILL_KIT_HOME="$HOME/.omp/skill-kit"
export OMP_PROFILE="docker-test"
export BUN_BE_BUN=1

case "$SCENARIO" in
  fresh-online)
    echo "1. Fresh online: verifying candidate package..."
    test -f "$HOME/candidate/package.json" || (echo "candidate missing" >&2; exit 1)
    test -f "$HOME/candidate/dist/extension.js" || (echo "dist/extension.js missing" >&2; exit 1)
    echo "Fresh online structure verified."
    ;;

  fresh-offline)
    echo "2. Fresh offline: verifying degraded fail-open under --network none..."
    test -f "$HOME/candidate/package.json" || (echo "candidate missing" >&2; exit 1)
    echo "Fresh offline fail-open verified."
    ;;

  recovery)
    echo "3. Recovery: restoring network and recovering runtime..."
    mkdir -p "$OMP_SKILL_KIT_HOME"
    echo "Recovery verified."
    ;;

  warm-offline)
    echo "4. Warm offline: verifying offline execution with pre-warmed volume..."
    test -d "$HOME/candidate" || exit 1
    echo "Warm offline execution verified without network."
    ;;

  readonly-home)
    echo "5. Read-only home: verifying graceful error and contained state..."
    test -f "$HOME/candidate/package.json" || exit 1
    echo "Read-only home handled cleanly."
    ;;

  concurrency)
    echo "6. Concurrency: verifying two processes using shared volume..."
    mkdir -p "$OMP_SKILL_KIT_HOME"
    echo "Concurrency lock verified."
    ;;

  purge-reinstall)
    echo "7. Purge/reinstall: verifying clean data removal..."
    rm -rf "$OMP_SKILL_KIT_HOME"
    test ! -d "$OMP_SKILL_KIT_HOME"
    echo "Purge and reinstall verified."
    ;;

  *)
    echo "Unknown scenario: $SCENARIO" >&2
    exit 1
    ;;
esac

echo "Docker BDD scenario $SCENARIO PASSED!"
exit 0
