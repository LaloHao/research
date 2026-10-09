#!/usr/bin/env bash
# Re-records test/fixtures/llm/cli-success.json from the real Claude Code CLI with a trivial prompt.
# Uses a tiny amount of the user's Claude quota. Run only with the user's permission.
set -euo pipefail
out="test/fixtures/llm/cli-success.json"
echo "The paper says: we fine-tune BERT on 12k log lines." | claude -p --output-format json \
  --json-schema '{"type":"object","properties":{"method":{"type":"string"}},"required":["method"],"additionalProperties":false}' \
  --model haiku --max-budget-usd 0.05 --tools "" --no-session-persistence --strict-mcp-config --setting-sources "" \
  --system-prompt "Extract the method described in the input. Answer only through the structured output." \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const keep=["type","subtype","is_error","api_error_status","duration_ms","num_turns","result","structured_output","stop_reason","total_cost_usd","terminal_reason","modelUsage"];const o={};for(const k of keep)o[k]=d[k];o.session_id="00000000-0000-0000-0000-000000000000";process.stdout.write(JSON.stringify(o,null,2)+"\n")})' > "$out"
echo "wrote $out"
