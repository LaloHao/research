#!/usr/bin/env bash
# Re-records test/fixtures/llm/chat-stream.jsonl from the real Claude Code CLI with a trivial prompt and no tools.
# Uses a tiny amount of the user's Claude quota. Run only with the user's permission.
set -euo pipefail
out="test/fixtures/llm/chat-stream.jsonl"
echo "In one short sentence: what is a log parser?" | claude -p --output-format stream-json --verbose --include-partial-messages \
  --model haiku --max-budget-usd 0.05 --tools "" --no-session-persistence --strict-mcp-config --setting-sources "" \
  --system-prompt "Answer briefly." \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const keep=new Set(["system","stream_event","assistant","user","result"]);const out=[];for(const line of s.split("\n")){if(!line.trim())continue;const o=JSON.parse(line);if(!keep.has(o.type))continue;o.session_id="00000000-0000-0000-0000-000000000000";if(o.uuid)o.uuid="00000000-0000-0000-0000-000000000000";out.push(JSON.stringify(o))}process.stdout.write(out.join("\n")+"\n")})' > "$out"
echo "wrote $out (the parser test expects a tool call; add one by hand or adapt the test to what the CLI really sends)"
