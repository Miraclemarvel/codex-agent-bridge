// Deterministic stand-in for the documented dsh --profile headless --json wire.
let source = "";
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source),
  mode = process.argv[2] ?? "success";
const event = (e) => process.stdout.write(JSON.stringify(e) + "\n");
event({ type: "session", sessionId: "fixture-session" });
event({ type: "status", phase: "turn_start", turn: 1 });
if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "malformed") {
  process.stdout.write("unstructured log corrupting protocol\n");
  setInterval(() => {}, 1000);
} else {
  event({
    type: "status",
    phase: "turn_end",
    reason: { kind: mode === "fail" ? "error" : "completed" },
  });
  event({
    type: "final",
    text: JSON.stringify({
      sum: request.attempt === 1 ? 54 : 55,
      stage: request.attempt === 1 ? "draft" : "final",
    }),
  });
  if (mode === "early-final") setTimeout(() => process.exit(0), 150);
  else process.exit(mode === "fail" ? 1 : 0);
}
