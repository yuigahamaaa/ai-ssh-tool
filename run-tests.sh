#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

LOG_FILE="${ROOT_DIR}/test-$(date +%Y%m%d-%H%M%S).log"
NODE_BIN="${NODE_BIN:-node}"

echo "Starting tests at $(date)" > "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

TEST_FILES=(
  "dist/__tests__/logger.test.js"
  "dist/__tests__/daemon.test.js"
  "dist/__tests__/daemon-lifecycle.test.js"
  "dist/__tests__/session-manager.test.js"
  "dist/__tests__/profile-manager.test.js"
  "dist/__tests__/remote-shell.test.js"
  "dist/__tests__/remote-fs.test.js"
  "dist/__tests__/remote-tools.test.js"
  "dist/__tests__/connection.test.js"
  "dist/__tests__/gateway.test.js"
  "dist/__tests__/multi-hop-auth.test.js"
  "dist/__tests__/file-transfer.test.js"
  "dist/__tests__/background-exec.test.js"
  "dist/__tests__/port-forwarding.test.js"
  "dist/__tests__/error-handling.test.js"
  "dist/__tests__/mcp-server.test.js"
  "dist/__tests__/session-reuse.test.js"
  "dist/__tests__/daemon-ipc.test.js"
  "dist/__tests__/agent-auth.test.js"
)

FAILED=0

for TEST in "${TEST_FILES[@]}"; do
  if [ -f "$TEST" ]; then
    {
      echo ""
      echo "========================================"
      echo "Running test: $TEST"
      echo "Started at: $(date)"
      echo "========================================"
    } >> "$LOG_FILE"

    if command -v timeout >/dev/null 2>&1; then
      timeout 120 "$NODE_BIN" --test "$TEST" >> "$LOG_FILE" 2>&1
    else
      "$NODE_BIN" --test "$TEST" >> "$LOG_FILE" 2>&1
    fi
    EXIT_CODE=$?

    echo "Finished at: $(date)" >> "$LOG_FILE"
    echo "Exit code: $EXIT_CODE" >> "$LOG_FILE"

    if [ "$EXIT_CODE" -ne 0 ]; then
      echo "TEST FAILED: $TEST" >> "$LOG_FILE"
      FAILED=1
    fi
  else
    echo "Test file not found: $TEST" >> "$LOG_FILE"
    FAILED=1
  fi
done

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "All tests finished at $(date)" >> "$LOG_FILE"
echo "Log file: $LOG_FILE"

exit "$FAILED"
