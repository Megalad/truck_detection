import { spawn } from "node:child_process";

const processes = [
  spawn("npm", ["run", "dev:client"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:server"], { stdio: "inherit" }),
  spawn(".venv/bin/python", ["scripts/live_server.py"], { stdio: "inherit" }),
];

function stopAll(signal = "SIGTERM") {
  for (const child of processes) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stopAll();
      process.exit(code);
    }
  });
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
  process.exit(0);
});
