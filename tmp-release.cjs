const { spawnSync } = require("child_process");

const result = spawnSync("cmd", ["/c", "release.bat"], {
  cwd: process.cwd(),
  input: "4.0.1\n",
  encoding: "utf8",
});

console.log("=== status:", result.status);
console.log("=== stdout ===");
console.log(result.stdout || "(empty)");
console.log("=== stderr ===");
console.log(result.stderr || "(empty)");
if (result.error) console.log("=== error ===", result.error.message);
